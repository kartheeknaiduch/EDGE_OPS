import { describe, expect, it } from "vitest";
import { classify, extractUrls, fallbackSummary, filterToolUrls, formatTable, normalizeUrl, probe, type ProbeResult } from "../src/health";
import { parseLlm } from "../src/llm";

describe("normalizeUrl (SSRF guard)", () => {
  it("accepts public hosts and adds https", () => {
    const r = normalizeUrl("Example.ORG/health");
    expect(r).toMatchObject({ ok: true, label: "example.org/health" });
    expect(r.ok && r.url).toBe("https://example.org/health");
  });
  it.each([
    "http://localhost", "127.0.0.1", "http://10.0.0.5", "172.16.4.4", "192.168.1.1", "169.254.169.254",
    "http://100.64.0.1", "http://2130706433", "http://0x7f.1", "[::1]", "intranet", "db.internal", "printer.local",
    "https://user:pw@example.com", "example.com:8080", "ftp://example.com", "http://[fd00::1]/",
  ])("rejects %s", (input) => expect(normalizeUrl(input).ok).toBe(false));
  it("rejects empty input", () => expect(normalizeUrl("  ").ok).toBe(false));
});

describe("extractUrls / filterToolUrls (tool-call guard)", () => {
  it("extracts hosts, urls and IPs but not emails", () => {
    expect(extractUrls("Is cloudflare.com and https://example.org/a healthy? mail me@corp.com or 8.8.8.8")).toEqual([
      "cloudflare.com", "https://example.org/a", "8.8.8.8",
    ]);
  });
  it("keeps only hosts the user literally typed", () => {
    expect(filterToolUrls(["example.com"], "what is a canary deploy?")).toEqual([]);
    expect(filterToolUrls(["https://Cloudflare.com/x", "evil.com"], "check cloudflare.com please")).toEqual(["https://Cloudflare.com/x"]);
  });
  it("does not match a host inside a longer hostname", () => {
    expect(filterToolUrls(["example.com"], "check notexample.com")).toEqual([]);
    expect(filterToolUrls(["example.com"], "check example.community")).toEqual([]);
  });
  it("still lets unsafe user-typed hosts through so the SSRF guard can refuse them", () => {
    expect(filterToolUrls(["127.0.0.1"], "is 127.0.0.1 up?")).toEqual(["127.0.0.1"]);
  });
});

describe("classify", () => {
  it("maps status and latency to a verdict", () => {
    expect(classify(200, 100)).toBe("healthy");
    expect(classify(301, 100)).toBe("healthy");
    expect(classify(200, 2500)).toBe("degraded");
    expect(classify(404, 100)).toBe("degraded");
    expect(classify(503, 100)).toBe("down");
    expect(classify(null, 0)).toBe("down");
  });
});

describe("probe", () => {
  it("records status and latency", async () => {
    const r = await probe("https://x.test/", "x.test", (async () => new Response("ok", { status: 200 })) as typeof fetch);
    expect(r).toMatchObject({ status: 200, verdict: "healthy", label: "x.test" });
  });
  it("reports 530 as DNS failure", async () => {
    const r = await probe("https://x.test/", "x.test", (async () => new Response("", { status: 530 })) as typeof fetch);
    expect(r).toMatchObject({ verdict: "down", error: "DNS lookup failed" });
  });
  it("turns network errors into a down result", async () => {
    const r = await probe("https://x.test/", "x.test", (async () => { throw new Error("connection refused"); }) as typeof fetch);
    expect(r).toMatchObject({ status: null, verdict: "down", error: "connection refused" });
  });
  it("reports timeouts", async () => {
    const r = await probe("https://x.test/", "x.test", (async () => { throw new DOMException("t", "TimeoutError"); }) as typeof fetch, 50);
    expect(r.error).toBe("timed out after 50 ms");
  });
});

describe("formatting", () => {
  const rs: ProbeResult[] = [
    { url: "a", label: "a.com", verdict: "healthy", status: 200, latencyMs: 90 },
    { url: "b", label: "b.com/x", verdict: "degraded", status: 200, latencyMs: 2100 },
    { url: "c", label: "c.com", verdict: "down", status: null, latencyMs: 30, error: "boom" },
  ];
  it("sorts slowest first", () => expect(formatTable(rs).split("\n")[0]).toContain("b.com/x"));
  it("summarises deterministically", () => {
    const s = fallbackSummary(rs);
    expect(s).toContain("1 of 3 targets healthy");
    expect(s).toContain("Down: c.com");
    expect(s).toContain("Slowest: b.com/x at 2100 ms");
  });
});

describe("parseLlm", () => {
  it("handles plain text", () => expect(parseLlm({ response: " hi " })).toEqual({ text: "hi", toolUrls: null }));
  it("handles tool_calls with object args", () =>
    expect(parseLlm({ response: null, tool_calls: [{ name: "run_health_check", arguments: { urls: ["a.com"] } }] }).toolUrls).toEqual(["a.com"]));
  it("handles JSON-string args and a single url string", () =>
    expect(parseLlm({ tool_calls: [{ name: "run_health_check", arguments: '{"urls":"a.com"}' }] }).toolUrls).toEqual(["a.com"]));
  it("handles a tool call returned as an object in response", () =>
    expect(parseLlm({ response: { name: "run_health_check", arguments: { urls: ["b.com"] } } }).toolUrls).toEqual(["b.com"]));
  it("ignores unknown tools and garbage", () => {
    expect(parseLlm({ tool_calls: [{ name: "other", arguments: {} }] }).toolUrls).toBeNull();
    expect(parseLlm(undefined)).toEqual({ text: "", toolUrls: null });
  });
});
