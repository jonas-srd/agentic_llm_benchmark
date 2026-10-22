import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import { one, type Queryable } from "./db.js";
import type { Settings } from "./config.js";
export const digest = (value: string, secret: string) =>
  createHmac("sha256", secret).update(value).digest("hex");
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function issueToken(secret: string) {
  const token = randomBytes(40).toString("base64url");
  return { token, hash: digest(token, secret) };
}
export function requireAdmin(value: string | undefined, settings: Settings) {
  if (!value || !safeEqual(value, settings.adminKey))
    throw new HTTPException(401, {
      message: "Administrator authentication required",
    });
}
export async function owned(
  db: Queryable,
  id: string,
  authorization: string | undefined,
  settings: Settings,
) {
  const session = await one(db, "SELECT * FROM sessions WHERE id=$1", [id]);
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  if (
    !session ||
    !token ||
    !safeEqual(digest(token, settings.sessionSecret), session.token_hash)
  )
    throw new HTTPException(401, { message: "Invalid session token" });
  return session;
}
