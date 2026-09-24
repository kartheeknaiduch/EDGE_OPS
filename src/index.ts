import type { Env } from "./env";

export { ChatSession } from "./session";
export { HealthCheckWorkflow } from "./workflow";

const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store" },
  });

async function rateLimited(req: Request, env: Env): Promise<boolean> {
  if (!env.RATE_LIMITER) return false; // binding absent (mock config): skip
  const { success } = await env.RATE_LIMITER.limit({ key: req.headers.get("CF-Connecting-IP") ?? "unknown" });
  return !success;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

    if (url.pathname === "/api/health" && req.method === "GET") return json({ ok: true });

    const stubFor = (id: string) => env.SESSION.get(env.SESSION.idFromName(id));

    if (url.pathname === "/api/history" && req.method === "GET") {
      const id = url.searchParams.get("sessionId") ?? "";
      if (!SESSION_RE.test(id)) return json({ error: "invalid sessionId" }, 400);
      return json(await stubFor(id).history());
    }

    if ((url.pathname === "/api/chat" || url.pathname === "/api/reset") && req.method === "POST") {
      if (await rateLimited(req, env)) return json({ error: "Too many requests. Slow down." }, 429);
      const raw = await req.text();
      if (raw.length > 4000) return json({ error: "request too large" }, 413);
      let body: { sessionId?: unknown; message?: unknown };
      try { body = JSON.parse(raw); } catch { return json({ error: "invalid JSON" }, 400); }
      if (typeof body.sessionId !== "string" || !SESSION_RE.test(body.sessionId)) return json({ error: "invalid sessionId" }, 400);

      const stub = stubFor(body.sessionId);
      if (url.pathname === "/api/reset") { await stub.reset(); return json({ ok: true }); }
      if (typeof body.message !== "string") return json({ error: "message must be a string" }, 400);
      return json(await stub.chat(body.sessionId, body.message));
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
