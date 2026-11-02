import { timingSafeEqual } from "node:crypto";

/** Require a high-entropy server-only secret and compare it without timing leaks. */
export function isValidProjectSyncWorkerSecret(
  authorization: string | null,
  expectedSecret: string | undefined,
): boolean {
  if (!expectedSecret || expectedSecret.length < 32 || !/^[A-Za-z0-9_-]+$/.test(expectedSecret)) return false;
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = authorization.slice("Bearer ".length);
  if (!supplied || supplied.length !== expectedSecret.length) return false;
  return timingSafeEqual(Buffer.from(supplied, "utf8"), Buffer.from(expectedSecret, "utf8"));
}
