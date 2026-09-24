import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env, WorkflowParams } from "./env";
import { normalizeUrl, probe, type ProbeResult } from "./health";
import { summarize } from "./llm";

/**
 * Durable multi-step health check. Each probe, the summary and the save are separate steps, so a crash or
 * redeploy resumes from the last completed step instead of re-probing everything.
 */
export class HealthCheckWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
    const { sessionId, checkId, urls } = event.payload;
    const stub = this.env.SESSION.get(this.env.SESSION.idFromName(sessionId));

    try {
      // Probes run in parallel; each retries transient network failures with exponential backoff.
      const results: ProbeResult[] = await Promise.all(
        urls.map(async (url) => {
          const n = normalizeUrl(url); // re-validate: never trust workflow params blindly
          if (!n.ok) return { url, label: url, verdict: "down", status: null, latencyMs: 0, error: n.reason } as ProbeResult;
          try {
            return await step.do(
              `probe ${n.label}`,
              { retries: { limit: 2, delay: "2 seconds", backoff: "exponential" }, timeout: "30 seconds" },
              async () => {
                const r = await probe(n.url, n.label);
                if (r.status === null) throw new Error(r.error ?? "network error"); // triggers a retry
                return r;
              },
            );
          } catch (e) {
            // Retries exhausted: record the target as down instead of failing the whole run.
            return {
              url: n.url, label: n.label, verdict: "down", status: null, latencyMs: 0,
              error: e instanceof Error ? e.message : "unreachable",
            } as ProbeResult;
          }
        }),
      );

      const summary = await step.do("summarise with Llama 3.3", async () => summarize(this.env, results));
      await step.do("save report to session memory", async () => stub.saveReport(checkId, results, summary));
    } catch (e) {
      await step.do("record failure", async () => stub.failCheck(checkId, e instanceof Error ? e.message : "unknown error"));
    }
  }
}
