(() => {
  const $ = (id) => document.getElementById(id);
  const log = $("log"), form = $("form"), input = $("input"), board = $("board"), boardSummary = $("board-summary");
  let sessionId;
  try { sessionId = localStorage.getItem("edgeops-session"); } catch { /* storage blocked */ }
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    try { localStorage.setItem("edgeops-session", sessionId); } catch { /* ignore */ }
  }
  let polling = null;

  const api = async (path, body) => {
    const res = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, ...body }) } : undefined);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
    return data;
  };

  function renderLog(messages, pending) {
    log.replaceChildren(...messages.map((m) => {
      const li = document.createElement("li");
      li.className = `msg ${m.role}` + (m.role === "assistant" && m.content.includes(" | ") ? " report" : "");
      li.textContent = m.content;
      return li;
    }));
    if (pending) {
      const li = document.createElement("li");
      li.className = "msg assistant pending";
      li.textContent = "Probing targets…";
      log.append(li);
    }
    log.scrollTop = log.scrollHeight;
  }

  function renderBoard(latest) {
    board.replaceChildren();
    if (!latest) { boardSummary.textContent = "No check yet."; return; }
    boardSummary.textContent = latest.summary || "";
    const max = Math.max(1, ...latest.results.map((r) => r.latencyMs));
    [...latest.results].sort((a, b) => b.latencyMs - a.latencyMs).forEach((r) => {
      const li = document.createElement("li");
      li.className = `row ${r.verdict}`;
      const top = document.createElement("div"); top.className = "top";
      const name = document.createElement("span"); name.className = "name"; name.textContent = r.label;
      const ms = document.createElement("span"); ms.textContent = r.status === null ? "no response" : `${r.latencyMs} ms`;
      top.append(name, ms);
      const bar = document.createElement("div"); bar.className = "bar";
      const fill = document.createElement("i"); fill.style.width = `${Math.max(4, (r.latencyMs / max) * 100)}%`;
      bar.append(fill);
      const meta = document.createElement("div"); meta.className = "meta";
      meta.textContent = `${r.verdict}${r.status ? ` · HTTP ${r.status}` : ""}${r.error ? ` · ${r.error}` : ""}`;
      li.append(top, bar, meta);
      board.append(li);
    });
  }

  async function refresh() {
    const h = await api(`/api/history?sessionId=${encodeURIComponent(sessionId)}`);
    renderLog(h.messages, h.pending);
    renderBoard(h.latest);
    if (h.pending && !polling) polling = setInterval(refresh, 2000);
    if (!h.pending && polling) { clearInterval(polling); polling = null; }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    input.value = ""; form.querySelector("button").disabled = true;
    try { await api("/api/chat", { message }); } catch (err) {
      const li = document.createElement("li"); li.className = "msg assistant"; li.textContent = err.message; log.append(li);
    }
    form.querySelector("button").disabled = false; input.focus();
    refresh().catch(() => {});
  });

  $("reset").addEventListener("click", async () => { await api("/api/reset", {}); refresh(); });
  refresh().catch(() => {});
  input.focus();
})();
