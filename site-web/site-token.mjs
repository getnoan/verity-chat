/**
 * Signed chat session token.
 *
 * WHY IT EXISTS. The wrap-up endpoint used to take `contactId` straight from the request
 * body with no session, no signature and no origin check, then write a note and create up
 * to five tasks against that contact — tagged and ASSIGNED TO VERITY, which is the fleet's
 * trigger, so the support agent then emailed that contact. Anyone who could POST could put
 * mail in front of any person in the CRM. The reply endpoint had the mirror hole:
 * `isSubscriber` arrived from the client, making the support-task path caller-selectable.
 *
 * The server issues a token where it resolves the contact — the one place that has actually
 * seen the email — and every later write verifies it. A caller can still obtain a token by
 * naming an address, so this does not make the endpoint private; what it removes is writing
 * against a contact you did not name.
 *
 * NO NEW SECRET BY DEFAULT. The key derives from the NOAN key this service already needs to
 * do anything at all, so there is no deploy in which the secret is missing and this silently
 * fails open. SESSION_SECRET overrides where one is set (Render generates one per service).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { noanKey } from "../agents/noan.mjs";

const TTL_MS = 6 * 60 * 60 * 1000;

function signingKey() {
  const explicit = process.env.SESSION_SECRET;
  if (explicit) return explicit;
  const k = noanKey();
  if (!k) throw new Error("No signing key: set SESSION_SECRET, or a NOAN key for one to derive from");
  return createHmac("sha256", k).update("noan-site:chat-session:v1").digest("hex");
}

const sign = payload => createHmac("sha256", signingKey()).update(payload).digest("base64url");

export function issueChatToken({ contactId, email, isSubscriber }) {
  const payload = [contactId, String(email).toLowerCase(), isSubscriber ? "1" : "0", String(Date.now() + TTL_MS)].join("|");
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${sign(payload)}`;
}

/** The identity a token carries, or null. Every failure returns null rather than
 *  distinguishing malformed from expired from forged, so this cannot be used as an oracle. */
export function verifyChatToken(token) {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;

  const payload = Buffer.from(token.slice(0, dot), "base64url").toString("utf8");
  const given = Buffer.from(token.slice(dot + 1));
  let want;
  try { want = Buffer.from(sign(payload)); } catch { return null; }
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  const [contactId, email, sub, expires] = payload.split("|");
  if (!contactId || !email || !expires) return null;
  if (Number(expires) < Date.now()) return null;
  return { contactId, email, isSubscriber: sub === "1" };
}
