import { createHash } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { CaseSpec } from "@clinical/shared";
import { one, now, type Queryable } from "../lib/db.js";

export const AssetSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  mime_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
  data_base64: z
    .string()
    .min(4)
    .max(8_000_000)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export async function saveAsset(db: Queryable, input: unknown) {
  const asset = AssetSchema.parse(input);
  const bytes = Buffer.from(asset.data_base64, "base64");
  const detected = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
    ? "image/jpeg"
    : bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "image/png"
      : bytes.toString("ascii", 0, 4) === "RIFF" &&
          bytes.toString("ascii", 8, 12) === "WEBP"
        ? "image/webp"
        : null;
  if (
    detected !== asset.mime_type ||
    bytes.length > 6_000_000 ||
    createHash("sha256").update(bytes).digest("hex") !== asset.id
  )
    throw new HTTPException(422, { message: "Invalid image or checksum" });
  await db.query(
    "INSERT INTO case_media(id,mime_type,data_base64,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING",
    [asset.id, asset.mime_type, bytes.toString("base64"), now()],
  );
  return { id: asset.id };
}
export async function requireAssets(db: Queryable, cases: CaseSpec[]) {
  for (const id of new Set(
    cases.flatMap((c) => (c.media || []).map((m) => m.asset_id)),
  )) {
    if (!(await one(db, "SELECT id FROM case_media WHERE id=$1", [id])))
      throw new HTTPException(422, {
        message: "Import case images before the study",
      });
  }
}
