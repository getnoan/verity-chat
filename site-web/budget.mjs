/**
 * The daily spend cap for the public chat endpoint.
 *
 * /chat is unauthenticated by design — the signed token stops a caller writing to someone
 * else's record, it does not stop anyone burning the model key — so this cap is what stands
 * between an abusive script and the bill. It therefore FAILS CLOSED:
 *
 *   - a cap it cannot measure is not a cap. With a budget set and no metering configured
 *     (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY), every message is refused, unless the
 *     operator says SITE_BUDGET_UNMETERED=1 and so accepts the risk by name;
 *   - a failed read (the api_usage table missing, Supabase down, a bad key) refuses too, and
 *     is retried after a minute rather than cached for the usual five.
 *
 * It used to fail OPEN on both, which made the documented worst case ("per day = this number")
 * false on exactly the installs least likely to notice: a fresh deploy whose api_usage table
 * was never created read as $0 spent, forever. SITE_DAILY_BUDGET_USD=0 still turns the cap
 * off — deliberately, by the operator — as it always did.
 */

const TTL_OK_MS = 5 * 60_000;
const TTL_FAIL_MS = 60_000;

/**
 * @param {object}   o
 * @param {number}   o.budget   USD per UTC day; 0 = no cap
 * @param {object}   o.env      reads SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SITE_BUDGET_UNMETERED
 * @param {Function} o.read     ({ since }) => usage rows [{ agent, cost_usd }] (usage-log.mjs readUsage)
 * @param {Function} o.onOver   (spent, day) => void — the alert; called on each fresh over-budget read
 * @param {string}   o.agent    the usage-log agent label to sum
 * @returns {() => Promise<boolean>} true = refuse this message
 */
export function createBudgetGate({ budget, env = process.env, read, onOver = () => {}, agent = "site-chat", now = Date.now, log = console.error }) {
  let cache = { at: 0, ttl: 0, over: false };
  const metered = () => Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
  const unmeteredOk = () => env.SITE_BUDGET_UNMETERED === "1";

  return async function overBudget() {
    if (!budget) return false;
    if (!metered()) return !unmeteredOk();
    if (now() - cache.at < cache.ttl) return cache.over;
    try {
      const since = new Date(now()); since.setUTCHours(0, 0, 0, 0);
      const rows = await read({ since: since.toISOString() });
      const spent = rows.filter(r => r.agent === agent).reduce((s, r) => s + (parseFloat(r.cost_usd) || 0), 0);
      const over = spent >= budget;
      cache = { at: now(), ttl: TTL_OK_MS, over };
      if (over) onOver(spent, since.toISOString().slice(0, 10));
      return over;
    } catch (e) {
      log(`site-chat: budget unreadable, refusing until it is (${e.message})`);
      cache = { at: now(), ttl: TTL_FAIL_MS, over: true };
      return true;
    }
  };
}

/** One line for the boot log: what the cap will actually do on this deploy. */
export function describeBudget({ budget, env = process.env }) {
  if (!budget) return "budget cap OFF (SITE_DAILY_BUDGET_USD=0)";
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) return `budget $${budget}/day, metered`;
  if (env.SITE_BUDGET_UNMETERED === "1") return `!! budget $${budget}/day UNMETERED (SITE_BUDGET_UNMETERED=1): spend is NOT capped`;
  return `!! budget $${budget}/day but no metering (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY): every chat is refused until it is configured`;
}
