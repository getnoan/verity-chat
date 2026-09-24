#!/usr/bin/env node
/**
 * The site chat's daily spend cap fails CLOSED (site-web/budget.mjs).
 *
 * /chat is a public, unauthenticated endpoint on the operator's model key, so a cap that
 * cannot measure spend must refuse rather than wave everything through. It used to wave:
 * no metering configured → cap off, a failed read → cap off. A fresh deploy with the
 * api_usage table never created read as $0 spent forever. These cases pin the other way.
 *
 * Run:  node agents/test-site-budget.mjs
 */
import { createBudgetGate, describeBudget } from "../site-web/budget.mjs";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}`); } };
const METERED = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" };
const rows = (...usd) => async () => usd.map(c => ({ agent: "site-chat", cost_usd: String(c) }));
const quiet = () => {};

// budget 0 is the operator turning the cap off on purpose
ok("budget 0 → never refuses", !(await createBudgetGate({ budget: 0, env: {}, read: rows(), log: quiet })()));

// unmetered
ok("no metering → refuses", await createBudgetGate({ budget: 20, env: {}, read: rows(), log: quiet })());
ok("no metering but SITE_BUDGET_UNMETERED=1 → allows",
   !(await createBudgetGate({ budget: 20, env: { SITE_BUDGET_UNMETERED: "1" }, read: rows(), log: quiet })()));
ok("half the metering config is no metering",
   await createBudgetGate({ budget: 20, env: { SUPABASE_URL: "https://x.supabase.co" }, read: rows(), log: quiet })());

// metered
ok("under budget → allows", !(await createBudgetGate({ budget: 20, env: METERED, read: rows(5, 4.99), log: quiet })()));
let alerted = null;
ok("at budget → refuses", await createBudgetGate({ budget: 20, env: METERED, read: rows(15, 5), onOver: (s) => { alerted = s; }, log: quiet })());
ok("…and alerts with the spend", alerted === 20);
ok("other agents' rows do not count",
   !(await createBudgetGate({ budget: 20, env: METERED, read: async () => [{ agent: "spend-worker", cost_usd: "99" }], log: quiet })()));

// a failed read refuses, and is retried after a minute, not five
let t = 1_000_000, calls = 0, broken = true;
const gate = createBudgetGate({
  budget: 20, env: METERED, now: () => t, log: quiet,
  read: async () => { calls++; if (broken) throw new Error("Supabase 404: relation api_usage does not exist"); return []; },
});
ok("read error → refuses", await gate());
t += 30_000;
ok("…still refused inside the minute, without re-reading", (await gate()) && calls === 1);
broken = false; t += 31_000;
ok("…re-read after a minute, and allows once the meter works", !(await gate()) && calls === 2);

// the boot line says what will actually happen
ok("describe: unmetered is loud", /every chat is refused/.test(describeBudget({ budget: 20, env: {} })));
ok("describe: opted-out is loud", /NOT capped/.test(describeBudget({ budget: 20, env: { SITE_BUDGET_UNMETERED: "1" } })));
ok("describe: metered", /metered/.test(describeBudget({ budget: 20, env: METERED })));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
