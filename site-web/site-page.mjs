/** The site path a visitor is on, or undefined when it is not a plain path on this site. */
export function cleanPage(raw) {
  if (typeof raw !== "string") return undefined;
  const p = raw.trim();
  if (!p.startsWith("/") || p.startsWith("//") || p.length > 200) return undefined;
  if (/[\s<>"'`\\]/.test(p)) return undefined;
  return p;
}
