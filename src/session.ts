import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { askLlm, SYSTEM_PROMPT, type ChatMsg } from "./llm";
import {
  extractUrls, filterToolUrls, formatTable, MAX_TARGETS, normalizeUrl,
  type ProbeResult,
} from "./health";

const MAX_MESSAGE = 2000;
const MAX_STORED = 200;
const CONTEXT_MESSAGES = 12;
const MAX_RUNNING = 3;

interface CheckRow { id: string; status: string; results: string | null; summary: string | null; ts: number }

const HELP =
  "I check whether websites and APIs are healthy.\n" +
  "Try: 'Is cloudflare.com and example.org healthy?'\n" +
  "Commands: /check <url> [url...], /reset (clear memory), /help.\n" +
  "After a check, ask follow-ups such as 'which endpoint was slowest?'.";

/** One Durable Object per chat session: SQLite-backed message history + check records (the assistant's memory). */
export class ChatSession extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL, ts INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS checks (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, urls TEXT NOT NULL, results TEXT, summary TEXT, ts INTEGER NOT NULL)`);
  }

  // ---------- RPC methods ----------

  async chat(sessionId: string, message: string): Promise<{ reply: string }> {
    const text = message.trim();
    if (!text) return { reply: "Say something first." };
    if (text.length > MAX_MESSAGE) return { reply: `Messages are limited to ${MAX_MESSAGE} characters.` };

    if (text === "/help") return { reply: HELP };
    if (text === "/reset") { await this.reset(); return { reply: "Memory cleared. Running checks were cancelled." }; }

    this.addMessage("user", text);
    let reply: string;
    if (text.startsWith("/check")) {
      const targets = extractUrls(text.slice(6));
      reply = targets.length ? await this.startCheck(sessionId, targets) : "Usage: /check <url> [url...]";
    } else {
      reply = await this.converse(sessionId, text);
    }
    this.addMessage("assistant", reply);
    return { reply };
  }

  history() {
    const messages = this.sql.exec("SELECT role, content, ts FROM messages ORDER BY id").toArray();
    const running = this.sql.exec("SELECT COUNT(*) AS n FROM checks WHERE status = 'running'").one().n as number;
    const latest = this.latestCheck();
    return {
      messages,
      pending: running > 0,
      latest: latest?.results ? { ts: latest.ts, summary: latest.summary, results: JSON.parse(latest.results) as ProbeResult[] } : null,
    };
  }

  async reset(): Promise<void> {
    const running = this.sql.exec("SELECT id FROM checks WHERE status = 'running'").toArray();
    // Delete rows first so a late saveReport() can never resurrect a cleared chat, then best-effort cancel.
    this.sql.exec("DELETE FROM messages");
    this.sql.exec("DELETE FROM checks");
    for (const r of running) {
      try { await (await this.env.HEALTH_WORKFLOW.get(r.id as string)).terminate(); } catch { /* already finished */ }
    }
  }

  /** Called by the Workflow when probing + summarising is done. Ignored if the check was reset away. */
  saveReport(checkId: string, results: ProbeResult[], summary: string): void {
    const row = this.sql.exec("SELECT status FROM checks WHERE id = ?", checkId).toArray()[0];
    if (!row || row.status !== "running") return;
    this.sql.exec("UPDATE checks SET status='done', results=?, summary=? WHERE id=?", JSON.stringify(results), summary, checkId);
    this.addMessage("assistant", `${summary}\n\n${formatTable(results)}`);
  }

  failCheck(checkId: string, reason: string): void {
    const row = this.sql.exec("SELECT status FROM checks WHERE id = ?", checkId).toArray()[0];
    if (!row || row.status !== "running") return;
    this.sql.exec("UPDATE checks SET status='failed', summary=? WHERE id=?", reason, checkId);
    this.addMessage("assistant", `The health check failed: ${reason}`);
  }

  // ---------- internals ----------

  private async converse(sessionId: string, userText: string): Promise<string> {
    const prompt = this.buildPrompt();
    try {
      const out = await askLlm(this.env, prompt, true);
      if (out.toolUrls) {
        const kept = filterToolUrls(out.toolUrls, userText);
        if (kept.length) return await this.startCheck(sessionId, kept);
        // Model asked for hosts the user never typed: ignore the tool call and answer normally.
        const again = await askLlm(this.env, prompt, false);
        return again.text || "I couldn't work out which sites to check. Try '/check example.org'.";
      }
      return out.text || "I don't have an answer for that. Try /help.";
    } catch {
      return "The language model is unavailable right now. You can still run '/check <url>'.";
    }
  }

  private async startCheck(sessionId: string, rawTargets: string[]): Promise<string> {
    const targets = rawTargets.slice(0, MAX_TARGETS).map(normalizeUrl);
    const good = targets.filter((t): t is Extract<typeof t, { ok: true }> => t.ok);
    if (!good.length) {
      return "I can't probe that: " + targets.map((t) => (t.ok ? "" : `${t.input} (${t.reason})`)).join("; ") + ".";
    }
    const running = this.sql.exec("SELECT COUNT(*) AS n FROM checks WHERE status='running'").one().n as number;
    if (running >= MAX_RUNNING) return "Too many checks are already running in this session. Wait for one to finish.";

    const checkId = crypto.randomUUID();
    this.sql.exec("INSERT INTO checks (id, status, urls, ts) VALUES (?, 'running', ?, ?)", checkId, JSON.stringify(good.map((g) => g.url)), Date.now());
    await this.env.HEALTH_WORKFLOW.create({ id: checkId, params: { sessionId, checkId, urls: good.map((g) => g.url) } });

    const skipped = targets.filter((t) => !t.ok).map((t) => (t.ok ? "" : `${t.input} (${t.reason})`));
    return (
      `Checking ${good.map((g) => g.label).join(", ")} now. I'll post the report here when it finishes.` +
      (skipped.length ? ` Skipped: ${skipped.join("; ")}.` : "") +
      (rawTargets.length > MAX_TARGETS ? ` Only the first ${MAX_TARGETS} targets are checked.` : "")
    );
  }

  private latestCheck(): CheckRow | undefined {
    return this.sql.exec("SELECT id, status, results, summary, ts FROM checks WHERE status='done' ORDER BY ts DESC LIMIT 1").toArray()[0] as unknown as CheckRow | undefined;
  }

  private buildPrompt(): ChatMsg[] {
    const latest = this.latestCheck();
    const memory = latest?.results
      ? `\n\nLatest check (slowest first): endpoint | verdict | status | latency\n${formatTable(JSON.parse(latest.results))}\nSummary: ${latest.summary}`
      : "\n\nNo health check has been run in this session yet.";
    const recent = this.sql
      .exec("SELECT role, content FROM (SELECT id, role, content FROM messages ORDER BY id DESC LIMIT ?) ORDER BY id", CONTEXT_MESSAGES)
      .toArray() as unknown as ChatMsg[];
    return [{ role: "system", content: SYSTEM_PROMPT + memory }, ...recent];
  }

  private addMessage(role: "user" | "assistant", content: string) {
    this.sql.exec("INSERT INTO messages (role, content, ts) VALUES (?, ?, ?)", role, content, Date.now());
    this.sql.exec("DELETE FROM messages WHERE id <= (SELECT MAX(id) FROM messages) - ?", MAX_STORED);
  }
}

