import type { ChatSession } from "./session";

export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface WorkflowParams {
  sessionId: string;
  checkId: string;
  urls: string[];
}

export interface Env {
  AI: Ai;
  SESSION: DurableObjectNamespace<ChatSession>;
  HEALTH_WORKFLOW: Workflow<WorkflowParams>;
  ASSETS: Fetcher;
  RATE_LIMITER?: RateLimiter;
  MOCK_AI?: string;
}
