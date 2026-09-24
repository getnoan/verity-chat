/**
 * The chat widget (OSS-WEB-AGENTS-PLAN P2) — one script tag, any site.
 *
 *   <script src="https://chat.yourcompany.com/widget.js" async
 *           data-name="Assistant" data-accent="#0e7a68"
 *           data-greeting="Ask me anything about what we do."></script>
 *
 * Framework-free, no build step, no dependencies. The service origin is
 * derived from the script's own src; all state lives in a shadow root so
 * the host page's CSS never bleeds in (and ours never bleeds out). The
 * protocol is the service's own: POST /contact for a signed token, POST
 * /chat for the SSE stream (delta / trace / done events), sendBeacon
 * /chat-end on leave. sessionStorage keeps the token and transcript for
 * the tab only — closing the tab ends the conversation.
 *
 * This file is served by the service (GET /widget.js) so the embed and
 * the API can never version-skew: one deploy updates both.
 */
(() => {
  "use strict";
  const script = document.currentScript;
  if (!script || window.__verityChatLoaded) return;
  window.__verityChatLoaded = true;

  const ORIGIN = new URL(script.src).origin;
  const NAME = script.dataset.name || "Assistant";
  const ACCENT = script.dataset.accent || "#0e7a68";
  const GREETING = script.dataset.greeting || `Hi — I'm ${NAME}. Ask me anything.`;
  const SS = window.sessionStorage;
  const KEY = "verity-chat-v1";

  const state = (() => {
    try { return JSON.parse(SS.getItem(KEY)) || {}; } catch { return {}; }
  })();
  state.history = Array.isArray(state.history) ? state.history : [];
  state.sessionId = state.sessionId || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  const save = () => { try { SS.setItem(KEY, JSON.stringify(state)); } catch {} };

  /* ---------------- shell ---------------- */
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;z-index:2147483000;bottom:0;right:0;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .launch {
    position: fixed; bottom: 20px; right: 20px; width: 54px; height: 54px;
    border-radius: 50%; border: none; cursor: pointer; background: ${ACCENT};
    color: #fff; box-shadow: 0 6px 20px rgba(0,0,0,.25); font-size: 22px; line-height: 1;
  }
  .launch:hover { filter: brightness(1.08); }
  .panel {
    position: fixed; bottom: 88px; right: 20px; width: 360px; max-width: calc(100vw - 24px);
    height: 520px; max-height: calc(100vh - 110px); display: none; flex-direction: column;
    background: #fff; color: #1c1c1e; border-radius: 14px; overflow: hidden;
    box-shadow: 0 12px 40px rgba(0,0,0,.28); border: 1px solid rgba(0,0,0,.08);
  }
  .panel.open { display: flex; }
  .head { padding: 13px 16px; background: ${ACCENT}; color: #fff; display: flex; align-items: center; gap: 8px; }
  .head b { font-size: 14px; font-weight: 600; flex: 1; }
  .head button { background: none; border: none; color: #fff; font-size: 17px; cursor: pointer; padding: 2px 6px; }
  .msgs { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 9px; }
  .m { max-width: 86%; padding: 9px 12px; border-radius: 12px; font-size: 13.5px; line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; }
  .m.u { align-self: flex-end; background: ${ACCENT}; color: #fff; border-bottom-right-radius: 4px; }
  .m.a { align-self: flex-start; background: #f1f1f4; border-bottom-left-radius: 4px; }
  .trace { align-self: flex-start; font-size: 11px; color: #8a8a90; padding: 0 4px; }
  .gate { padding: 18px 16px; display: flex; flex-direction: column; gap: 9px; }
  .gate p { margin: 0; font-size: 13px; color: #48484d; line-height: 1.5; }
  .gate input { padding: 10px 12px; border: 1px solid #d5d5da; border-radius: 8px; font-size: 13.5px; }
  .gate input:focus { outline: 2px solid ${ACCENT}; border-color: transparent; }
  .gate button, .bar button {
    padding: 10px 14px; border: none; border-radius: 8px; background: ${ACCENT};
    color: #fff; font-size: 13.5px; font-weight: 600; cursor: pointer;
  }
  .gate .err { color: #b3261e; font-size: 12px; min-height: 14px; margin: 0; }
  .bar { display: none; gap: 8px; padding: 10px; border-top: 1px solid #ececf0; }
  .bar.on { display: flex; }
  .bar textarea {
    flex: 1; resize: none; border: 1px solid #d5d5da; border-radius: 8px;
    padding: 9px 11px; font-size: 13.5px; height: 40px; max-height: 110px; line-height: 1.4;
  }
  .bar textarea:focus { outline: 2px solid ${ACCENT}; border-color: transparent; }
  .bar button:disabled { opacity: .5; cursor: default; }
</style>
<button class="launch" aria-label="Open chat" aria-expanded="false">&#9998;</button>
<div class="panel" role="dialog" aria-label="${NAME} chat">
  <div class="head"><b>${NAME}</b><button class="x" aria-label="Close chat">&#10005;</button></div>
  <div class="msgs"></div>
  <div class="gate">
    <p>${GREETING}</p>
    <input type="email" placeholder="you@example.com" aria-label="Your email" autocomplete="email">
    <p class="err"></p>
    <button>Start chatting</button>
  </div>
  <div class="bar">
    <textarea placeholder="Write a message" aria-label="Your message"></textarea>
    <button>Send</button>
  </div>
</div>`;

  const $ = sel => root.querySelector(sel);
  const launch = $(".launch"), panel = $(".panel"), msgs = $(".msgs");
  const gate = $(".gate"), gateInput = gate.querySelector("input"), gateErr = gate.querySelector(".err"), gateBtn = gate.querySelector("button");
  const bar = $(".bar"), input = bar.querySelector("textarea"), sendBtn = bar.querySelector("button");

  const el = (cls, text) => { const d = document.createElement("div"); d.className = cls; d.textContent = text; msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; return d; };

  function showChat() {
    gate.style.display = "none";
    bar.classList.add("on");
    if (!msgs.childElementCount) {
      el("m a", GREETING);
      for (const m of state.history) el(`m ${m.role === "user" ? "u" : "a"}`, m.content);
    }
  }

  launch.addEventListener("click", () => {
    const open = panel.classList.toggle("open");
    launch.setAttribute("aria-expanded", String(open));
    if (open && state.token) showChat();
    if (open) (state.token ? input : gateInput).focus();
  });
  $(".x").addEventListener("click", () => { panel.classList.remove("open"); launch.setAttribute("aria-expanded", "false"); });

  /* ---------------- the email gate → signed token ---------------- */
  async function startChat() {
    const email = gateInput.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { gateErr.textContent = "Enter a work email to start."; return; }
    gateErr.textContent = "";
    gateBtn.disabled = true; gateBtn.textContent = "One moment";
    try {
      const r = await fetch(`${ORIGIN}/contact`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const d = await r.json();
      if (!r.ok || !d.token) throw new Error(d.error || "could not start");
      Object.assign(state, { token: d.token, email });
      save();
      showChat();
      input.focus();
    } catch (e) {
      gateErr.textContent = e.message === "Invalid email" ? "That email does not look right." : "Could not start the chat. Try again.";
    } finally {
      gateBtn.disabled = false; gateBtn.textContent = "Start chatting";
    }
  }
  gateBtn.addEventListener("click", startChat);
  gateInput.addEventListener("keydown", e => { if (e.key === "Enter") startChat(); });

  /* ---------------- the turn: POST /chat, read the SSE stream ---------------- */
  let busy = false;
  async function send() {
    const text = input.value.trim();
    if (!text || busy || !state.token) return;
    busy = true; sendBtn.disabled = true; input.value = "";
    state.history.push({ role: "user", content: text });
    save();
    el("m u", text);
    const out = el("m a", "…");
    try {
      const r = await fetch(`${ORIGIN}/chat`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          history: state.history, token: state.token,
          page: location.pathname, sessionId: state.sessionId,
          supportTaskCreated: state.supportTaskCreated === true,
        }),
      });
      if (!r.ok || !r.body) {
        const d = await r.json().catch(() => ({}));
        out.textContent = d.error || "Reply failed. Try again.";
        state.history.pop(); save();
        return;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "", answer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!line.startsWith("data: ")) continue;
          let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          if (ev.delta) { answer += ev.delta; out.textContent = answer; msgs.scrollTop = msgs.scrollHeight; }
          if (ev.trace && ev.trace.label) el("trace", `${ev.trace.glyph || ""} ${ev.trace.label} · ${ev.trace.detail || ""}`.trim());
          if (ev.error) { out.textContent = answer || ev.error; }
          if (ev.done) {
            answer = ev.reply || answer;
            out.textContent = answer;
            if (ev.supportTaskCreated) state.supportTaskCreated = true;
          }
        }
      }
      state.history.push({ role: "assistant", content: answer || out.textContent });
      save();
    } catch {
      out.textContent = "Connection dropped. Try again.";
      state.history.pop(); save();
    } finally {
      busy = false; sendBtn.disabled = false; input.focus();
    }
  }
  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });

  /* ---------------- wrap-up on leave (beacon: text/plain, no preflight) ---------------- */
  let ended = false;
  function end() {
    if (ended || !state.token || state.history.length < 2) return;
    ended = true;
    try {
      navigator.sendBeacon(`${ORIGIN}/chat-end`, JSON.stringify({
        token: state.token, history: state.history,
        sessionId: state.sessionId, supportTaskCreated: state.supportTaskCreated === true,
      }));
    } catch {}
  }
  addEventListener("pagehide", end);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") end(); ended = false; });

  document.body ? document.body.appendChild(host)
    : addEventListener("DOMContentLoaded", () => document.body.appendChild(host));
})();
