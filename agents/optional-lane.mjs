/**
 * Optional modules: code that uses one when its file is there and does without
 * it when it is not. A missing file returns the caller's fallback, with
 * `present: false`. A file that exists but fails to load throws, so a syntax
 * error never reads as "switched off".
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function loadLane(name, fallback = {}, base = import.meta.url) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`loadLane: not a lane name: ${name}`);
  const url = new URL(`./${name}.mjs`, base);
  if (!existsSync(fileURLToPath(url))) return { ...fallback, present: false };
  const mod = await import(url.href);
  return { ...mod, present: true };
}
