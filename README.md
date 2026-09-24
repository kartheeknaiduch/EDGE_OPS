# EdgeOps: AI infrastructure health assistant on Cloudflare

Chat with an assistant that tells you whether websites and APIs are healthy. Ask *"Is cloudflare.com and example.org healthy?"*
and a durable **Workflow** probes the targets in parallel, **Llama 3.3** summarises the findings, and the report is stored in the
chat session's **Durable Object** memory so you can ask follow-ups like *"which endpoint was slowest?"*.

Built for the Cloudflare Software Engineer assignment. It covers every required component:

| Requirement | Implementation |
| --- | --- |
| **LLM** | Workers AI, `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, with tool calling (`src/llm.ts`) |
| **Workflow / coordination** | `HealthCheckWorkflow` (Cloudflare Workflows): parallel probe steps with retries, an LLM summary step, a save-to-memory step (`src/workflow.ts`) |
| **User input (chat)** | Static chat UI served by Workers Static Assets (`public/`) talking to a JSON API (`src/index.ts`) |
| **Memory / state** | One SQLite-backed `ChatSession` Durable Object per session: message history, check records, sliding context window (`src/session.ts`) |

## Architecture

```
Browser ──POST /api/chat──▶ Worker (per-IP rate limit → 429)
   ▲                           │ RPC
   │                           ▼
   │                 ChatSession (Durable Object, SQLite)
   │ poll              1. store message
   │ /api/history      2. prompt = system + latest-check table (slowest first) + last 12 messages
   │                   3. Workers AI (Llama 3.3) with tool run_health_check
   │                   4. tool-call guard → SSRF guard → start Workflow
   │                            ▼
   │                 HealthCheckWorkflow
   │                   ├─ step: probe target 1 ┐ parallel, each retried
   │                   ├─ step: probe target N ┘ (2 retries, exponential backoff)
   │                   ├─ step: summarise with Llama 3.3 (deterministic fallback)
   └── report ◀────────└─ step: ChatSession.saveReport(...)
```

Design choices worth knowing:

- **Durable by construction.** Each probe, the summary and the save are separate `step.do` calls, so a crash or redeploy resumes instead of re-probing. Retries exhausted → that target is recorded as `down`; the run still completes.
- **SSRF guard** (`normalizeUrl`): only public http(s) hosts on default ports; rejects localhost, private/link-local/CGNAT ranges (incl. `169.254.169.254`), IPv6 literals, single-label and `.internal`/`.local` names, and credentials in URLs. Max 5 targets per check, 3 concurrent checks per session. The Workflow re-validates targets rather than trusting its params.
- **Tool-call guard** (`filterToolUrls`): LLMs sometimes invent tool arguments. Only hosts that literally appear in the user's message are honoured; otherwise the tool call is dropped and the model is asked again without tools.
- **Rate limiting**: `POST /api/chat` and `/api/reset` are limited per client IP with the Workers Rate Limiting binding (20 / 60 s, config under `ratelimits` in `wrangler.jsonc`; change `namespace_id` if it clashes in your account).
- **Reset is safe**: `reset()` deletes rows first, then terminates running workflows; `saveReport` ignores unknown check ids, so a late report cannot appear in a cleared chat.
- **Small prompt-injection surface**: only status, latency and error text from probes reach the model, never response bodies.
- **Graceful degradation**: if the model is unavailable, `/check <url>` still works and the summary falls back to a deterministic one.

## Run it

Requires Node 20+ and a Cloudflare account (Workers AI, Workflows and SQLite Durable Objects are available on the Workers free plan; check current limits).

```bash
npm install
npx wrangler login
npm run dev        # local dev; the AI binding uses your account's remote Workers AI
npm run deploy     # publish to <name>.<your-subdomain>.workers.dev
```

No account handy? `npm run dev:mock` runs the same Worker, Durable Object and Workflow locally with the model swapped for a deterministic stub (`MOCK_AI=1`, never set in the production config). Probes still need internet.

Try: `Is cloudflare.com and example.org healthy?`, `/check github.com`, `Which endpoint was slowest?`, `/help`, `/reset`.

## Tests and CI

```bash
npm run typecheck   # tsc --noEmit
npm test            # 35 Vitest unit tests: SSRF guard, tool-call guard, probing, classification, formatting, LLM response parsing
```

`.github/workflows/ci.yml` type-checks and tests on every push and PR, and on `main` deploys with Wrangler when the repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/chat` | `{ sessionId, message }` → `{ reply }` (rate limited) |
| GET | `/api/history?sessionId=` | `{ messages, pending, latest }` |
| POST | `/api/reset` | Clear a session's memory and cancel running checks (rate limited) |
| GET | `/api/health` | Liveness |

## Known limits / next steps

- Probes follow redirects and do not defend against DNS rebinding (outbound Worker fetches cannot reach private networks, but treat the guard as defence in depth).
- Replies are polled, not streamed. Next: stream tokens over SSE/WebSockets with Durable Object hibernation.
- Next: scheduled re-checks via `step.sleep` or Cron Triggers with regression alerts; history in D1 for trend questions.

## AI-assisted development

This project was built with AI assistance (Claude). The prompt history is in [`PROMPTS.md`](./PROMPTS.md).
