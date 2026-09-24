/**
 * Site chat brain.
 *
 * The persona, style rules and guardrails are not string literals. They are the Site Chat
 * Agent Config and Site Chat Playbook facts, fetched each run, so retuning how the agent
 * speaks to a prospect is a fact edit rather than a deploy.
 *
 * What deliberately stays in code: the grounding slug list,
 * pagination, the cache split, and the SUPPORT_TASK control-line mechanics. A fact-editor
 * should not have to touch API plumbing to retune business judgment.
 */

import { noanGet } from "../agents/noan.mjs";

export const SUPPORT_TASK_MARKER = "SUPPORT_TASK:";
export const SUPPORT_TASK_RX = /\s*SUPPORT_TASK:\s*(\{[\s\S]*?\})\s*$/;

const CONFIG_SLUG = process.env.SITE_CHAT_CONFIG_BLOCK_SLUG;
const PLAYBOOK_SLUG = process.env.SITE_CHAT_PLAYBOOK_BLOCK_SLUG;
const PAUSE_SLUG = process.env.SITE_CHAT_PAUSE_BLOCK_SLUG;

/* Grounding. Curated by hand IN ENV (SITE_CHAT_GROUNDING_SLUGS, comma-separated) — our
 * production pins its own list on Render; a downstream install names its own blocks, and
 * nothing about our workspace ships as a default (the pack rule). Every slug listed is
 * EXPECTED to resolve — see reportMissingGrounding for why an empty result is never
 * treated as routine. */
const EXTERNAL_BLOCKS = (process.env.SITE_CHAT_GROUNDING_SLUGS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

/* Optional: a stack whose every block grounds the chat (our Product Manual). Unset = no
 * manual section, and the audience gating below simply has nothing to gate. */
const PRODUCT_MANUAL_STACK_SLUG = (process.env.SITE_CHAT_MANUAL_STACK_SLUG || "").trim();

/* Manual blocks withheld from prospects — a DENY-list, so a NEW manual block reaches them
 * without a deploy. Only blocks that need an account to be useful belong here. */
const SUPPORT_ONLY_MANUAL = new Set((process.env.SITE_CHAT_MANUAL_SUPPORT_ONLY ||
  "manual-troubleshooting,manual-settings-and-account").split(",").map(s => s.trim()).filter(Boolean));

/* One runaway fact must not crowd the prompt. 16,000 truncates nothing currently in the
 * fact layer; at the old 8,000 exactly one block hit it — product-features, cut 42%, the
 * single most useful document for someone deciding whether to buy. */
const FACT_CHAR_CAP = 16000;

const BRAIN_TTL_MS = Math.max(1, parseFloat(process.env.SITE_CHAT_BRAIN_TTL_MIN || "5")) * 60_000;
const FACTS_TTL_MS = 5 * 60_000;

function log(...a) { console.log(...a); }

async function factText(slug) {
  if (!slug) return "";
  const r = await noanGet(`/facts?block_slug=${encodeURIComponent(slug)}&per_page=1`);
  return (r.items || [])[0]?.content || "";
}

/* ---------------- conversation shaping ----------------
 *
 * TWO LIMITS THAT LOOK LIKE ONE, AND MUST NOT BE CONFLATED.
 *
 *   maxHistory  how many messages go into the prompt. A window, for cost.
 *   maxTurns    how long a conversation may run before we stop. An ending.
 *
 * The first version counted user turns AFTER applying the window, so with
 * maxHistory 30 below maxTurns 40 the count could never exceed 40 and the cap
 * was unreachable dead code. Nothing failed; the stop simply never happened.
 * Returning both figures from one place is what stops that recurring.
 *
 * The cap is a courtesy stop, not a defence: the client sends the history, so
 * anyone can evade it by sending less. The daily budget is the real limit. */
export function prepareTurns(raw, { maxHistory = 30, maxCharsPer = 4000 } = {}) {
  const control = new RegExp("[\\u0000-\\u001f\\u007f]", "g");
  const clean = v => String(v ?? "").replace(control, " ").trim().slice(0, maxCharsPer);
  const all = (Array.isArray(raw) ? raw : [])
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map(m => ({ role: m.role, content: clean(m.content) }));
  return {
    // Counted over everything submitted, never over the window.
    userTurns: all.filter(m => m.role === "user").length,
    turns: all.slice(-maxHistory),
  };
}

/* ---------------- brain: Config + Playbook ---------------- */

let brainCache = { at: 0, brain: null };

export async function brain() {
  if (brainCache.brain && Date.now() - brainCache.at < BRAIN_TTL_MS) return brainCache.brain;
  const [config, playbook] = await Promise.all([
    factText(CONFIG_SLUG),
    factText(PLAYBOOK_SLUG).catch(() => ""),
  ]);
  if (!config) {
    // A NOAN blip must never degrade a live surface, but booting un-instructed is worse
    // than not booting: the model would answer from general knowledge on a page that
    // promises the opposite.
    if (brainCache.brain) return brainCache.brain;
    throw new Error(`No fact in SITE_CHAT_CONFIG_BLOCK_SLUG '${CONFIG_SLUG}'. Refusing to run un-instructed.`);
  }
  brainCache = { at: Date.now(), brain: { config, playbook } };
  return brainCache.brain;
}

/* ---------------- pause ----------------
 * Two switches, deliberately. SITE_CHAT_PAUSED is a hard stop that depends on nothing;
 * the pause fact is the soft one anyone can flip without a deploy.
 *
 * The fact fails OPEN when unreadable. Fail-closed was considered, but that reasoning
 * belongs to a page-publishing agent, where the risk is publishing something
 * wrong. Here the risk is the opposite: a transient NOAN error would take the public
 * marketing chat offline. The env var is the switch that always works, so there is never a
 * moment with no kill switch — which is the property fail-closed was reaching for. */
let pauseCache = { at: 0, reason: null };

export async function paused() {
  if (process.env.SITE_CHAT_PAUSED === "1") return "env SITE_CHAT_PAUSED=1";
  if (Date.now() - pauseCache.at < 60_000) return pauseCache.reason;
  let reason = null;
  try {
    const first = (await factText(PAUSE_SLUG)).split("\n").map(s => s.trim()).find(Boolean) || "";
    if (/^paused\b/i.test(first)) reason = "pause fact says paused";
  } catch (e) {
    log(`  warn: pause fact unreadable (${e.message}) — continuing; SITE_CHAT_PAUSED=1 is the hard stop`);
  }
  pauseCache = { at: Date.now(), reason };
  return reason;
}

/* ---------------- grounding ---------------- */

async function manualBlocks() {
  try {
    if (!PRODUCT_MANUAL_STACK_SLUG) return [];
    const d = await noanGet(`/stacks?slug=${PRODUCT_MANUAL_STACK_SLUG}`);
    const stack = (d.items || []).find(s => s.slug === PRODUCT_MANUAL_STACK_SLUG);
    return (stack?.blocks || []).map(b => ({
      slug: b.slug,
      label: b.slug.replace(PRODUCT_MANUAL_STACK_SLUG ? `${PRODUCT_MANUAL_STACK_SLUG}-` : /^\0$/, "").replace(/^[0-9a-f]{5}-/, ""),
    }));
  } catch (e) {
    log(`  warn: product manual stack lookup failed: ${e.message}`);
    return [];
  }
}

/**
 * Say something useful when a curated grounding block comes back with no facts.
 *
 * `GET /facts?block_slug=` answers 200 with an empty array in three different situations
 * and the read cannot tell them apart: the key is stack-limited and the block is out of
 * scope (an empty 200, NOT a 403); the slug is stale; or the block genuinely has no fact.
 *
 * That matters most right here, because this service runs on the stack-limited
 * stack-limited site key: mis-scope a stack and its blocks quietly stop existing. Block
 * LISTINGS are scope-filtered too, so a follow-up lookup separates the cases.
 */
async function reportMissingGrounding(slugs) {
  for (const slug of slugs) {
    let verdict = "no fact recorded, or out of scope (block lookup failed)";
    try {
      const r = await noanGet(`/blocks?slug=${encodeURIComponent(slug)}&per_page=1`);
      verdict = (r.items || []).some(b => b.slug === slug)
        ? "block is visible but has NO FACT — nothing recorded on it yet"
        : "block NOT VISIBLE to this key — out of scope for the stack-limited key, or the slug is stale";
    } catch { /* keep the default verdict */ }
    console.error(`[site-chat] grounding block missing: ${slug} — ${verdict}`);
  }
}

const factsCache = new Map();   // audience -> { at, text, labels }

/* The trace names blocks to the visitor, so a block needs a reader-facing name: the
 * slug is plumbing. The curated blocks get their name here; a manual
 * block gets its slug humanised with the stack and hash prefixes dropped. The prompt
 * sections keep block.label untouched — that text is the cached prefix. */
const READER_NAMES = {};   // slug → the name the visitor sees; unlisted slugs are humanised
const ACRONYMS = new Set(["api", "mcp", "pr", "faq", "sso", "ai"]);
export function readerName(slug = "") {
  if (READER_NAMES[slug]) return READER_NAMES[slug];
  const words = slug
    .replace(PRODUCT_MANUAL_STACK_SLUG ? `${PRODUCT_MANUAL_STACK_SLUG}-` : /^\0$/, "")
    .split("-")
    .filter(w => w && !/^\d+$/.test(w) && !/^[0-9a-f]{5,}$/.test(w));
  while (words[0] === "manual") words.shift();
  const out = words.map(w => (ACRONYMS.has(w) ? w.toUpperCase() : w)).join(" ");
  return out ? out[0].toUpperCase() + out.slice(1) : "Facts";
}

/** The blocks the last grounding actually loaded, by label, for the trace the widget
 *  shows (the site's universe plan, rung 3, in getnoan-new-site). Runs the grounding if it has not run yet. */
export async function groundingLabels(audience = "prospect") {
  await groundingText(audience);
  return factsCache.get(audience)?.labels ?? [];
}

export async function groundingText(audience = "prospect") {
  const hit = factsCache.get(audience);
  if (hit && Date.now() - hit.at < FACTS_TTL_MS) return hit.text;

  const manual = await manualBlocks();
  const blocks = [
    ...EXTERNAL_BLOCKS.map(slug => ({ slug, label: slug })),
    ...manual.filter(b => audience === "subscriber" || !SUPPORT_ONLY_MANUAL.has(b.label)),
  ].filter((b, i, all) => all.findIndex(c => c.slug === b.slug) === i);

  // Concurrent: sequentially this was ~21 round trips before the first token, which on a
  // cold isolate measured 17.6s to first token against ~1.1s warm.
  const fetched = await Promise.all(blocks.map(async block => {
    try {
      const d = await noanGet(`/facts?block_slug=${encodeURIComponent(block.slug)}&per_page=25`);
      return { block, items: d.items || [] };
    } catch { return { block, items: [] }; }
  }));

  // Assembly stays strictly ordered: this text is the cached half of the prompt, so a
  // different section order is a different prefix and silently re-bills every turn.
  const cap = f => (f.content.length > FACT_CHAR_CAP
    ? `${f.content.slice(0, FACT_CHAR_CAP)}\n[...fact truncated]` : f.content);
  const sections = [];
  const labels = [];
  const missing = [];
  for (const { block, items } of fetched) {
    if (!items.length) {
      if (EXTERNAL_BLOCKS.includes(block.slug)) missing.push(block.slug);
      continue;
    }
    sections.push(`### ${block.label}\n${items.map(f => `- ${cap(f)}`).join("\n")}`);
    labels.push(readerName(block.slug));
  }
  if (missing.length) await reportMissingGrounding(missing);

  const text = sections.join("\n\n");
  factsCache.set(audience, { at: Date.now(), text, labels });
  return text;
}

/* ---------------- where the visitor is ----------------
 * The site sends the path the widget is open on, so the agent can open on the page's
 * subject. It is caller-supplied text, so it is reduced to a plain path or
 * dropped, and it goes in the per-visitor block, never the cached prefix. */
const PAGE_LABELS = {
  "/": "the homepage",
  "/pricing": "the Pricing page",
};

/** A path like "/agents", or undefined for anything that is not a plain site path. */
export function cleanPage(raw) {
  if (typeof raw !== "string") return undefined;
  const p = raw.trim();
  if (!p.startsWith("/") || p.startsWith("//") || p.length > 200) return undefined;
  if (/[\s<>"'`\\]/.test(p)) return undefined;
  return p;
}

/** One line for the prompt, or "" when the page is unknown. */
export function pageContext(page) {
  const p = cleanPage(page);
  if (!p) return "";
  const label = PAGE_LABELS[p]
    || (p.startsWith("/blog/") ? "a blog post"
      : p.startsWith("/use-cases/") ? "a use-case page"
      : p.startsWith("/case-studies/") ? "a case study"
      : p.startsWith("/compare/") ? "a comparison page"
      : `the page at ${p}`);
  const site = (process.env.SITE_NAME || "").trim() || "the site";
  return `The visitor is reading ${site}${p === "/" ? "" : p}, ${label}. When it fits, open on that page's subject. Do not say that you know which page they are on.`;
}

/* ---------------- the prompt ----------------
 * Split at a cache breakpoint. Everything identical between visitors — the Config, the
 * Playbook, and the grounding — is the cached first block; per-visitor and per-turn state
 * goes after it. Built the other way round, every turn re-bills the whole prefix and
 * cache_read stays at zero forever. */

export async function systemBlocks({ audience, email, name, supportTaskCreated, page }) {
  const { config, playbook } = await brain();
  const facts = await groundingText(audience);

  const stable = [
    config,
    playbook ? `\n## Playbook — how you sound\n${playbook}` : "",
    `\n## KNOWLEDGE (internal reference — do not quote verbatim)\n${facts}`,
  ].filter(Boolean).join("\n");

  const isSub = audience === "subscriber";
  const lines = [
    `You are speaking with ${isSub ? "an existing customer (subscriber)" : "a prospective customer (lead)"}.`,
    email
      ? `Visitor identity (already provided — do NOT ask for it again): name=${name || "(unknown)"} email=${email}.`
      : `Visitor identity is not yet known. Do not ask for an email address unless you need one to do something specific for them.`,
  ];
  if (email) lines.push(`If they ask to be contacted, confirm you already have their email (${email}) and do NOT ask again.`);
  const where = pageContext(page);
  if (where) lines.push(where);
  if (isSub) {
    lines.push(supportTaskCreated
      ? `A support case already exists for this conversation. Do NOT open another; reassure them the team will email them directly.`
      : `If a support case is warranted per the Config, end the reply with the control line exactly as the Playbook specifies. Once per conversation only.`);
  }

  return [{ text: stable, cache: true }, { text: lines.join("\n") }];
}

/* ---------------- SUPPORT_TASK control line ----------------
 * The model is told to end a support reply with a marker the visitor must never see.
 * Streaming deltas straight through would show it being typed, so hold back only the
 * longest suffix that could still become the marker — at most marker.length - 1
 * characters, so normal text streams at full granularity. */

export function createMarkerFilter(marker = SUPPORT_TASK_MARKER) {
  let held = "";
  let seen = false;
  return {
    push(chunk) {
      if (seen) return "";
      held += chunk;
      const at = held.indexOf(marker);
      if (at !== -1) { seen = true; const out = held.slice(0, at); held = held.slice(at); return out; }
      let keep = 0;
      for (let n = Math.min(marker.length - 1, held.length); n > 0; n -= 1) {
        if (marker.startsWith(held.slice(held.length - n))) { keep = n; break; }
      }
      const out = held.slice(0, held.length - keep);
      held = held.slice(held.length - keep);
      return out;
    },
    flush() { if (seen) return ""; const rest = held; held = ""; return rest; },
  };
}
