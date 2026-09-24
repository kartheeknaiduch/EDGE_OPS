// Pure logic (no Cloudflare imports) so it can be unit tested in plain Node.

export type Verdict = "healthy" | "degraded" | "down";

export interface ProbeResult {
  url: string;
  label: string;
  verdict: Verdict;
  status: number | null;
  latencyMs: number;
  error?: string;
}

export type Normalized =
  | { ok: true; url: string; label: string }
  | { ok: false; input: string; reason: string };

export const MAX_TARGETS = 5;
export const SLOW_MS = 1500;

const BLOCKED_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".corp"];
const isIPv4 = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h);

function privateIPv4(h: string): boolean {
  const [a, b] = h.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||           // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** SSRF guard: only public http(s) hosts on default ports, no credentials. */
export function normalizeUrl(input: string): Normalized {
  const bad = (reason: string): Normalized => ({ ok: false, input, reason });
  const raw = input.trim().replace(/[.,;:!?)\]]+$/, "");
  if (!raw) return bad("empty target");
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return bad("not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return bad("only http/https targets are allowed");
  if (u.username || u.password) return bad("credentials in URLs are not allowed");
  if (u.port && u.port !== "80" && u.port !== "443") return bad("non-standard ports are not allowed");
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[")) return bad("IPv6 literals are not allowed");
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return bad("internal hostnames are not allowed");
  if (isIPv4(host)) {
    if (privateIPv4(host)) return bad("private or reserved IP addresses are not allowed");
  } else if (!host.includes(".")) {
    return bad("single-label hostnames are not allowed");
  }
  const path = u.pathname === "/" ? "" : u.pathname;
  return { ok: true, url: u.toString(), label: host + path };
}

const URL_RE =
  /(?<![@\w.-])(?:(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}|\d{1,3}(?:\.\d{1,3}){3})(?::\d{2,5})?(?:\/[^\s,;)]*)?/gi;

export function extractUrls(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(URL_RE)) seen.add(m[0].replace(/[.,;:!?]+$/, ""));
  return [...seen];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hostOf = (c: string) => c.trim().replace(/^[a-z]+:\/\//i, "").split(/[/:?#]/)[0].toLowerCase();

/** Tool-call guard: LLMs invent arguments. Keep only targets whose host literally appears in the user's message. */
export function filterToolUrls(candidates: string[], userMessage: string): string[] {
  const msg = userMessage.toLowerCase();
  return candidates.filter((c) => {
    const host = hostOf(c);
    return host.length > 0 && new RegExp(`(?<![a-z0-9.-])${escapeRe(host)}(?![a-z0-9-])`).test(msg);
  });
}

export function classify(status: number | null, latencyMs: number): Verdict {
  if (status === null || status >= 500) return "down";
  if (status >= 400 || latencyMs > SLOW_MS) return "degraded";
  return "healthy";
}

export async function probe(
  url: string,
  label: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const res = await fetchFn(url, {
      method: "GET",
      redirect: "follow",
      headers: { "user-agent": "edgeops-health-probe/1.0" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - t0;
    // Cloudflare answers 530 (error 1016) when the hostname does not resolve.
    const error = res.status === 530 ? "DNS lookup failed" : undefined;
    return { url, label, status: res.status, latencyMs, verdict: classify(res.status, latencyMs), error };
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return {
      url, label, status: null, latencyMs: Date.now() - t0, verdict: "down",
      error: timedOut ? `timed out after ${timeoutMs} ms` : e instanceof Error ? e.message : "network error",
    };
  }
}

export const slowestFirst = (r: ProbeResult[]) => [...r].sort((a, b) => b.latencyMs - a.latencyMs);

export function formatTable(results: ProbeResult[]): string {
  return slowestFirst(results)
    .map((r) => `${r.label} | ${r.verdict} | ${r.status ?? "no response"} | ${r.latencyMs} ms${r.error ? ` | ${r.error}` : ""}`)
    .join("\n");
}

export function fallbackSummary(results: ProbeResult[]): string {
  const down = results.filter((r) => r.verdict === "down");
  const degraded = results.filter((r) => r.verdict === "degraded");
  const s = slowestFirst(results)[0];
  const parts = [`${results.length - down.length - degraded.length} of ${results.length} targets healthy.`];
  if (down.length) parts.push(`Down: ${down.map((r) => r.label).join(", ")}.`);
  if (degraded.length) parts.push(`Degraded: ${degraded.map((r) => r.label).join(", ")}.`);
  if (s) parts.push(`Slowest: ${s.label} at ${s.latencyMs} ms.`);
  return parts.join(" ");
}
