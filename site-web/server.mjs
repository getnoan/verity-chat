#!/usr/bin/env node
/**
 * The site chat service: a grounded assistant for a public website.
 *
 * The website keeps only the embed (this service serves it at /widget.js); everything
 * touching NOAN or Anthropic lives here. Its brain is facts, and it has a pause switch, a
 * daily budget, and a state ledger.
 *
 * ROUTES
 *   POST /contact     resolve the visitor's contact, return a signed session token
 *   POST /chat        streaming reply (SSE)
 *   POST /chat-end    conversation wrap-up — memo + routed tasks
 *   GET  /healthz
 *
 * IDENTITY. Every write takes the signed token, never a caller-supplied contactId. See
 * site-token.mjs for what that closes.
 *
 * COLD START. Netlify recycles isolates, and a cold one paid ~7s to first token even after
 * the grounding fetch was parallelised, against ~1.1s warm. A long-lived process holds that
 * cache, which is much of why this surface moved at all.
 *
 * NOT HERE YET. The demo-request and site-preview captures still run on Netlify. They are
 * independent of the chat, and site-preview alone is ~2,200 lines with a Firecrawl crawl and
 * a design-pack vocabulary; porting it in the same change would turn one reviewable diff
 * into two unreviewable ones. Phase 3 step 5 moves them.
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import {
  assertNoanKey, findOrCreateContactByEmail, noanPost, noanPut, findTagId,
} from "../agents/noan.mjs";
import { callClaudeStream } from "../agents/anthropic.mjs";
import { readUsage, setUsageContext } from "../agents/usage-log.mjs";
import { sendEmail } from "../agents/resend.mjs";
import { createBudgetGate, describeBudget } from "./budget.mjs";
import {
  brain, paused, systemBlocks, createMarkerFilter, prepareTurns, SUPPORT_TASK_RX,
  cleanPage, groundingLabels,
} from "./site-chat.mjs";
import { issueChatToken, verifyChatToken } from "./site-token.mjs";
import { agentName, agentIdentityId } from "../agents/required-env.mjs";

/* The site this chat fronts, for copy only (e.g. "example.com"). */
const SITE_NAME = (process.env.SITE_NAME || "").trim() || "the site";

const PORT = parseInt(process.env.PORT || "8080", 10);
const MODEL = process.env.SITE_CHAT_MODEL || "claude-haiku-4-5-20251001";
const MAX_TURNS = parseInt(process.env.SITE_CHAT_MAX_TURNS || "40", 10);
const MAX_HISTORY = parseInt(process.env.SITE_CHAT_MAX_HISTORY || "30", 10);
const DAILY_BUDGET_USD = parseFloat(process.env.SITE_DAILY_BUDGET_USD || "20");
// No address default (required-env.mjs): a downstream copy with ESCALATE_TO
// unset must not mail ITS budget alerts to us. Unset = the alert is logged
// instead. The budget LOCK below is independent and still applies.
const ESCALATE_TO = (process.env.ESCALATE_TO || "").trim() || null;
const VERITY_ID = agentIdentityId();
/* Workspace-specific ids come ONLY from env (production pins its own on Render;
 * nothing about our workspace is a default that ships — the pack rule). Unset:
 * no lead tag on create, and subscriber detection falls back to the tag NAME
 * match below, which needs no id at all. */
const LEAD_TAG_ID = (process.env.SITE_LEAD_TAG_ID || "").trim() || null;
const SUBSCRIBER_TAG_ID = (process.env.SITE_SUBSCRIBER_TAG_ID || "").trim() || null;

const ALLOWED_ORIGINS = (process.env.SITE_ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const log = (...a) => console.log(...a);

/* ---------------- budget ----------------
 * budget.mjs: the cap on an unauthenticated endpoint, failing CLOSED. */
const overBudget = createBudgetGate({
  budget: DAILY_BUDGET_USD,
  read: readUsage,
  onOver: (spent, day) => {
    if (!ESCALATE_TO) {
      console.log(`site-chat: over daily budget ($${spent.toFixed(2)}) and locked until midnight UTC; no alert sent (ESCALATE_TO unset)`);
    } else sendEmail({
      to: ESCALATE_TO, cc: false,
      subject: `Site chat hit its daily budget ($${spent.toFixed(2)} of $${DAILY_BUDGET_USD})`,
      text: `${agentName()} on ${SITE_NAME} spent $${spent.toFixed(2)} today (${day}) and stopped replying until midnight UTC. Raise SITE_DAILY_BUDGET_USD on the service if that is fine.`,
      idempotencyKey: `site-chat:budget-alert:${day}`,
    }).catch(() => {});
  },
});

/* ---------------- http helpers ---------------- */

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
  }
  res.setHeader("access-control-allow-methods", "POST, GET, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-max-age", "86400");
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/* sendBeacon cannot set content-type: application/json without a preflight it will not wait
 * for, so /chat-end must accept text/plain and parse it itself. The same-origin route this
 * replaces never had to care. */
function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", c => {
      n += c.length;
      if (n > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("bad json")); }
    });
    req.on("error", reject);
  });
}

const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]", "g");
const clean = (s, max) => String(s ?? "").replace(CONTROL_CHARS, " ").trim().slice(0, max);

const shape = raw => prepareTurns(raw, { maxHistory: MAX_HISTORY });

/* ---------------- routes ---------------- */

async function handleContact(req, res) {
  const body = await readBody(req);
  const email = clean(body.email, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: "Invalid email" });

  // allowIncompleteSweep, deliberately, and the only place in the fleet that sets it.
  // findOrCreateContactByEmail otherwise REFUSES to create when the contact sweep came up short,
  // because "not found" may mean "not read" and a wrong create is permanent (no DELETE
  // /contacts). That is right for the unattended agent paths, where a refusal parks the work for
  // a human and costs nothing. Here it would 500 a live visitor mid-form. The trade-off inverts:
  // a blocked lead is worse than a rare duplicate, and a duplicate surfaces in the next weekly
  // network-integrity run under assertion A, where it can be merged. So the website keeps its
  // pre-2026-09-14 behaviour, and does so by name rather than by accident.
  const { contact, created } = await findOrCreateContactByEmail(email, {
    name: clean(body.name, 120) || undefined,
    tagIds: LEAD_TAG_ID ? [LEAD_TAG_ID] : undefined,
    allowIncompleteSweep: true,
  });
  // A missed lookup here does more than duplicate a row: isSubscriber drives the whole
  // conversation, so a subscriber not found gets the prospect script with support off.
  const tags = contact.tags || [];
  const isSubscriber = !created &&
    (tags.some(t => (t.name || "").toLowerCase() === "subscriber") ||
     (SUBSCRIBER_TAG_ID && tags.some(t => t.id === SUBSCRIBER_TAG_ID)) === true);

  json(res, 200, {
    contactId: contact.id,
    isSubscriber,
    created,
    token: issueChatToken({ contactId: contact.id, email, isSubscriber }),
  });
}

async function handleChat(req, res) {
  const body = await readBody(req);
  const { turns, userTurns } = shape(body.history);
  if (!turns.length) return json(res, 400, { error: "empty history" });
  // userTurns counts everything submitted; `turns` is only the prompt window.
  // Counting the window instead is what made this cap unreachable.
  if (userTurns > MAX_TURNS) {
    return json(res, 429, { error: "This conversation has run long — start a new one." });
  }

  const pauseReason = await paused();
  if (pauseReason) {
    log(`  chat refused: ${pauseReason}`);
    return json(res, 503, { error: `${agentName()} is offline for a moment. Please try again shortly.` });
  }
  if (await overBudget()) {
    return json(res, 429, { error: "I'm at my usage limit for today. Please come back tomorrow, or reach out through the site." });
  }

  // Identity from the signed token only, never the body: isSubscriber gates the
  // support-task path, so a caller-supplied flag was a caller-selectable privilege.
  const id = verifyChatToken(body.token);
  const audience = id?.isSubscriber ? "subscriber" : "prospect";
  const page = cleanPage(body.page);
  const system = await systemBlocks({
    audience,
    email: id?.email,
    name: clean(body.name, 120) || undefined,
    supportTaskCreated: body.supportTaskCreated === true,
    page,
  });

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = o => res.write(`data: ${JSON.stringify(o)}\n\n`);

  // The trace (the site's universe plan, rung 3, in getnoan-new-site): the widget shows what she actually did, the
  // way the app's thinking pane does. One honest line per thing, never a performance:
  // the blocks this reply stands on, and the support case if one is opened below.
  // Clients that do not know the frame ignore it.
  const labels = await groundingLabels(audience);
  send({ trace: { glyph: "\u2192", label: "facts", detail: `${labels.length} blocks \u00b7 ${labels.join(" \u00b7 ")}`, tone: "read" } });

  const filter = createMarkerFilter();
  let raw = "";
  try {
    setUsageContext({ agent: "site-chat", action: audience });
    const out = await callClaudeStream({
      model: MODEL,
      max_tokens: 1024,
      system: system.map(b => ({
        type: "text",
        text: b.text,
        ...(b.cache ? { cache_control: { type: "ephemeral" } } : {}),
      })),
      messages: turns,
    }, {
      onText: t => { raw += t; const safe = filter.push(t); if (safe) send({ delta: safe }); },
    });
    const tail = filter.flush();
    if (tail) send({ delta: tail });
    // No recordUsage() here on purpose: callClaudeStream already writes the row, and it
    // picks up agent/action from the setUsageContext above. Logging it a second time
    // double-counts the spend, which would trip the daily budget at half its value.
    void out;

    const { reply, supportTaskCreated } = await applySupportLine(raw, {
      isSubscriber: audience === "subscriber",
      contactId: id?.contactId,
      email: id?.email,
      already: body.supportTaskCreated === true,
    });
    if (supportTaskCreated && body.supportTaskCreated !== true) {
      send({ trace: { glyph: "\u270e", label: "task", detail: "support case opened for the team", tone: "write" } });
    }
    send({ done: true, reply: reply || "Sorry, I didn't catch that.", supportTaskCreated });
  } catch (e) {
    console.error("[site-chat] reply failed:", e.message);
    send({ error: "Reply failed." });
  } finally {
    res.end();
  }
}

/** Act on a SUPPORT_TASK control line. Token-verified subscribers with a contact only, and
 *  never more than once per conversation. */
async function applySupportLine(rawText, ctx) {
  const m = rawText.match(SUPPORT_TASK_RX);
  if (!m) return { reply: rawText, supportTaskCreated: ctx.already };
  const reply = rawText.replace(SUPPORT_TASK_RX, "").trim();
  if (!ctx.isSubscriber || !ctx.contactId || !ctx.email || ctx.already) {
    return { reply, supportTaskCreated: ctx.already };
  }
  try {
    const parsed = JSON.parse(m[1]);
    const created = await createRoutedTask({
      title: clean(parsed.title, 200) || "Support request from chat",
      details: clean(parsed.details, 1500),
      contactId: ctx.contactId,
      source: `website chat assistant (${ctx.email})`,
      tags: ["support", "customer success"],
      assignVerity: true,
    });
    return { reply, supportTaskCreated: created };
  } catch (e) {
    console.error("[site-chat] control line failed:", e.message);
    return { reply, supportTaskCreated: ctx.already };
  }
}

/** A backlog task, tagged and optionally assigned to the agent, with the contact linked. Tag +
 *  assignee IS the fleet's trigger, so a failed tag strands the task invisibly. */
async function createRoutedTask({ title, details, contactId, source, tags, assignVerity, assignees = [], externalId }) {
  // NOAN rejects `details` over 2048 chars outright rather than truncating.
  const full = `${details}\n\nContact ID: ${contactId}\nSource: ${source}`.slice(0, 2048);
  // externalId makes a duplicate identifiable after the fact. It is NOT a pre-check: there
  // is no externalId filter on /tasks (an unrecognised query param is ignored, not
  // rejected), so checking would mean sweeping the whole board on a user-facing path. The
  // in-process guard above stops duplicates; this makes any that slip through findable.
  const created = await noanPost("/tasks", {
    title, details: full, status: "backlog",
    ...(externalId ? { externalId } : {}),
  });
  const taskId = created?.task?.id || created?.id;
  if (!taskId) throw new Error("task create returned no id");

  const tagIds = [];
  for (const name of tags || []) {
    const id = await findTagId(name).catch(() => null);
    if (id) tagIds.push(id);
  }
  if (tagIds.length) await noanPut(`/tasks/${taskId}/tags`, { tagIds }).catch(e => console.error("  tag link failed:", e.message));

  const ids = [...assignees, ...(assignVerity && VERITY_ID ? [VERITY_ID] : [])].filter(Boolean);
  if (ids.length) await noanPut(`/tasks/${taskId}/assignees`, { assigneeIds: ids }).catch(e => console.error("  assignee link failed:", e.message));
  await noanPut(`/tasks/${taskId}/contacts`, { contactIds: [contactId] }).catch(e => console.error("  contact link failed:", e.message));
  return true;
}

/* Wrap-up dedupe. The route this replaced had one and the first port dropped it — a
 * regression, not a missing nicety: /chat-end is fired by sendBeacon, which is
 * fire-and-forget and retry-prone, and a tab commonly fires BOTH visibilitychange:hidden
 * and pagehide. Without this, one closing tab writes the memo twice and files every
 * follow-up task twice, each of which is agent-assigned and therefore emails the contact.
 *
 * Over there it was explicitly "best-effort" because Cloudflare recycles isolates. Here the
 * process is long-lived, so the same guard is actually effective — which is the one place
 * this move makes an old compromise unnecessary rather than just faster. */
const WRAPPED_TTL_MS = 30 * 60_000;
const wrapped = new Map();

function alreadyWrapped(key) {
  const now = Date.now();
  for (const [k, t] of wrapped) if (now - t > WRAPPED_TTL_MS) wrapped.delete(k);
  if (wrapped.has(key)) return true;
  wrapped.set(key, now);
  return false;
}

async function handleChatEnd(req, res) {
  const body = await readBody(req);
  const id = verifyChatToken(body.token);
  const { turns } = shape(body.history);
  // The contact is whatever the SIGNED token says, never what the body claims.
  if (!id || !turns.length) return json(res, 200, { ok: false, skipped: true });

  // Key on the contact too: a sessionId is client-supplied, so it alone would let one
  // caller suppress another's wrap-up.
  const sessionId = clean(body.sessionId, 100) || `anon:${turns.length}`;
  const key = `${id.contactId}:${sessionId}`;
  if (alreadyWrapped(key)) return json(res, 200, { ok: true, deduped: true });

  const { wrapUp } = await import("./site-wrapup.mjs");
  try {
    const r = await wrapUp({
      identity: id, turns, createRoutedTask,
      alreadySupported: body.supportTaskCreated === true,
      externalIdBase: `site-chat:${id.contactId}:${sessionId}`,
    });
    json(res, 200, { ok: true, ...r });
  } catch (e) {
    console.error("[site-chat] wrap-up failed:", e.message);
    wrapped.delete(key);   // a failed wrap-up must stay retryable
    json(res, 500, { ok: false, error: "wrap-up failed" });
  }
}

/* The widget, read once at boot beside this file. A missing file is a build
 * error worth failing loudly on, not a 404 the embedder discovers in prod. */
const WIDGET_JS = readFileSync(new URL("./widget.js", import.meta.url), "utf8");

/* ---------------- server ---------------- */

async function route(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/healthz") { res.writeHead(200); res.end("ok"); return; }
  /* The embed (OSS-WEB-AGENTS-PLAN P2): the service serves its own widget, so
   * the script tag on the customer's site and this API can never version-skew.
   * Any origin may FETCH the script (it is public code); the chat endpoints
   * above stay behind the SITE_ALLOWED_ORIGINS CORS wall. */
  if (req.method === "GET" && url.pathname === "/widget.js") {
    // No CORS header on purpose: <script src> loads cross-origin without one,
    // and the allow-list above stays the ONLY origin story in this file.
    res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=300" });
    res.end(WIDGET_JS); return;
  }
  if (req.method === "GET" && url.pathname === "/widget-demo") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Widget demo</title></head><body style="font-family:sans-serif;padding:40px"><h1>Chat widget demo</h1><p>The launcher should sit bottom-right. This page stands in for your website.</p><script src="/widget.js" async></script></body></html>`);
    return;
  }
  if (req.method !== "POST") { res.writeHead(405); res.end(); return; }

  try {
    if (url.pathname === "/contact") return await handleContact(req, res);
    if (url.pathname === "/chat") return await handleChat(req, res);
    if (url.pathname === "/chat-end") return await handleChatEnd(req, res);
  } catch (e) {
    console.error(`[site-chat] ${url.pathname}:`, e.message);
    if (!res.headersSent) return json(res, 400, { error: e.message === "bad json" ? "bad json" : "request failed" });
    return res.end();
  }
  res.writeHead(404); res.end();
}

const server = createServer((req, res) => {
  route(req, res).catch(e => {
    console.error(e);
    try { if (!res.headersSent) res.writeHead(500); res.end(); } catch {}
  });
});

if (process.env.NODE_ENV !== "test") {
  assertNoanKey();
  server.listen(PORT, async () => {
    log(`verity-site listening on :${PORT}`);
    log(`  origins: ${ALLOWED_ORIGINS.join(", ")}`);
    log(`  model: ${MODEL} - ${describeBudget({ budget: DAILY_BUDGET_USD })}`);
    // Probe the meter once so a missing api_usage table is a boot line, not a silent refusal.
    if (DAILY_BUDGET_USD && process.env.SUPABASE_URL) {
      try { await readUsage({ since: new Date(Date.now() - 60_000).toISOString() }); }
      catch (e) { console.error(`  !! budget meter unreadable — chats are refused until it is (create api_usage from schema.sql): ${e.message}`); }
    }
    // Warm the brain so the first visitor does not pay the cold fetch.
    try { await brain(); log("  brain loaded from facts"); }
    catch (e) { console.error(`  !! brain unavailable: ${e.message}`); }
  });
}

export { server, route, createRoutedTask };
