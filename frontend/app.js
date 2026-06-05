// ── Config ────────────────────────────────────────────────────────────────────
const API_BASE = "http://localhost:8000";
const SESSION_ID = "session_" + Math.random().toString(36).slice(2, 9);

// ── State ─────────────────────────────────────────────────────────────────────
let isStreaming = false;
let turnCount = 0;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("queryInput");
const sendBtn = document.getElementById("sendBtn");
const statusBar = document.getElementById("statusBar");
const emptyState = document.getElementById("emptyState");
const apiStatus = document.getElementById("apiStatus");
const statusText = document.getElementById("statusText");
const memCount = document.getElementById("mem-count");
const charCount = document.getElementById("charCount");
const clearBtn = document.getElementById("clearBtn");

// ── Marked config ─────────────────────────────────────────────────────────────
if (typeof marked !== "undefined") {
  marked.setOptions({ breaks: true, gfm: true });
}

function renderMarkdown(text) {
  if (typeof marked === "undefined") return escapeHtml(text);
  return marked.parse(text);
}

function escapeHtml(t) {
  return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ── Health check ──────────────────────────────────────────────────────────────
async function checkHealth() {
  try {
    const r = await fetch(`${API_BASE}/health`);
    const data = await r.json();
    const dot = apiStatus.querySelector(".status-dot");
    if (data.status === "ok") {
      dot.classList.add("ok");
      statusText.textContent = data.gemini && data.tavily ? "All systems go" : "Demo mode";
    } else {
      dot.classList.add("error");
      statusText.textContent = "Backend error";
    }
  } catch {
    const dot = apiStatus.querySelector(".status-dot");
    dot.classList.add("error");
    statusText.textContent = "Not connected";
  }
}

// ── Capability panel helpers ──────────────────────────────────────────────────
function setCapState(id, state, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove("active", "done");
  if (state) el.classList.add(state);
  const statusEl = el.querySelector(".cap-status");
  if (statusEl && text) statusEl.textContent = text;
}

function resetCaps() {
  setCapState("cap-search", null, "idle");
  setCapState("cap-verify", null, "idle");
}

// ── Status bar ────────────────────────────────────────────────────────────────
function showStatus(text) {
  statusBar.innerHTML = `<div class="status-spinner"></div><span>${text}</span>`;
  statusBar.classList.add("active");
}

function hideStatus() {
  statusBar.classList.remove("active");
  statusBar.innerHTML = "";
}

// ── Message rendering ─────────────────────────────────────────────────────────
function addUserMessage(text) {
  if (emptyState) emptyState.style.display = "none";
  const wrap = document.createElement("div");
  wrap.className = "message user";
  wrap.innerHTML = `
    <div class="message-meta">${formatTime()}</div>
    <div class="message-bubble">${escapeHtml(text)}</div>
  `;
  messagesEl.appendChild(wrap);
  scrollBottom();
}

function createAssistantMessage() {
  const wrap = document.createElement("div");
  wrap.className = "message assistant";
  wrap.innerHTML = `
    <div class="message-meta">Nexus · ${formatTime()}</div>
    <div class="message-bubble"><span class="cursor"></span></div>
  `;
  messagesEl.appendChild(wrap);
  scrollBottom();
  return wrap.querySelector(".message-bubble");
}

function addToolCallBadge(type, query) {
  const badge = document.createElement("div");
  badge.className = "tool-call";
  const isVerify = type === "verify";
  badge.innerHTML = `
    <div class="tool-icon ${isVerify ? "verify" : "search"} spin"></div>
    <span>${isVerify ? "Verifying" : "Searching"}: ${escapeHtml(query)}</span>
  `;
  messagesEl.appendChild(badge);
  scrollBottom();
  return badge;
}

function formatTime() {
  return new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

function scrollBottom() {
  messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: "smooth" });
}

// ── Core send + stream ────────────────────────────────────────────────────────
async function sendQuery(query) {
  if (isStreaming || !query.trim()) return;
  isStreaming = true;
  sendBtn.disabled = true;
  inputEl.value = "";
  updateCharCount();

  addUserMessage(query);
  resetCaps();
  setCapState("cap-memory", "active", `${turnCount} turns`);

  const bubble = createAssistantMessage();
  let rawText = "";
  let activeBadge = null;
  let toolsUsed = [];
  let statusType = "thinking";

  showStatus("Thinking…");

  try {
    const resp = await fetch(`${API_BASE}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: SESSION_ID, query }),
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;

        let ev;
        try { ev = JSON.parse(raw); } catch { continue; }

        if (ev.type === "token") {
          rawText += ev.text;
          bubble.innerHTML = renderMarkdown(rawText) + '<span class="cursor"></span>';
          scrollBottom();
          if (statusType !== "streaming") {
            hideStatus();
            statusType = "streaming";
          }

        } else if (ev.type === "status") {
          const text = ev.text || "";
          showStatus(text);

          if (text.toLowerCase().startsWith("searching")) {
            const q = text.replace(/^searching:\s*/i, "");
            if (activeBadge) {
              activeBadge.querySelector(".tool-icon").classList.remove("spin");
            }
            activeBadge = addToolCallBadge("search", q);
            setCapState("cap-search", "active", "searching…");
            toolsUsed.push("web_search");

          } else if (text.toLowerCase().startsWith("verifying")) {
            const q = text.replace(/^verifying:\s*/i, "");
            if (activeBadge) {
              activeBadge.querySelector(".tool-icon").classList.remove("spin");
            }
            activeBadge = addToolCallBadge("verify", q);
            setCapState("cap-search", "done", "done");
            setCapState("cap-verify", "active", "verifying…");
            toolsUsed.push("verify");
          }

        } else if (ev.type === "done") {
          // finalize bubble
          bubble.innerHTML = renderMarkdown(rawText);
          if (toolsUsed.length > 0) {
            const tags = [...new Set(toolsUsed)].map(t =>
              `<span class="tool-tag">${t === "verify" ? "verified" : t}</span>`
            ).join("");
            bubble.innerHTML += `<div class="tool-tags">${tags}</div>`;
          }

          if (activeBadge) {
            activeBadge.querySelector(".tool-icon").classList.remove("spin");
          }
          setCapState("cap-search", toolsUsed.includes("web_search") ? "done" : null, toolsUsed.includes("web_search") ? "done" : "idle");
          setCapState("cap-verify", toolsUsed.includes("verify") ? "done" : null, toolsUsed.includes("verify") ? "done" : "idle");
          turnCount++;
          setCapState("cap-memory", "done", `${turnCount} turns`);
          hideStatus();
          scrollBottom();

        } else if (ev.type === "error") {
          bubble.innerHTML = `<span style="color:var(--red)">Error: ${escapeHtml(ev.text)}</span>`;
          hideStatus();
        }
      }
    }
  } catch (err) {
    bubble.innerHTML = `<span style="color:var(--red)">Connection error: ${escapeHtml(err.message)}</span>`;
    hideStatus();
  } finally {
    isStreaming = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }
}

// ── Input handling ────────────────────────────────────────────────────────────
function updateCharCount() {
  const n = inputEl.value.length;
  charCount.textContent = `${n} / 2000`;
}

inputEl.addEventListener("input", () => {
  updateCharCount();
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + "px";
});

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendQuery(inputEl.value.trim());
  }
});

sendBtn.addEventListener("click", () => sendQuery(inputEl.value.trim()));

// ── Suggestion chips ──────────────────────────────────────────────────────────
document.querySelectorAll(".suggestion").forEach(btn => {
  btn.addEventListener("click", () => {
    const q = btn.dataset.q;
    inputEl.value = q;
    updateCharCount();
    sendQuery(q);
  });
});

// ── Clear session ─────────────────────────────────────────────────────────────
clearBtn.addEventListener("click", async () => {
  if (isStreaming) return;
  try {
    await fetch(`${API_BASE}/session/${SESSION_ID}`, { method: "DELETE" });
  } catch {}
  messagesEl.innerHTML = "";
  if (emptyState) {
    messagesEl.appendChild(emptyState);
    emptyState.style.display = "";
  }
  turnCount = 0;
  resetCaps();
  setCapState("cap-memory", null, "0 turns");
});

// ── Boot ──────────────────────────────────────────────────────────────────────
checkHealth();
inputEl.focus();
