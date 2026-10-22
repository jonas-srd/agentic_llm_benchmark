import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { randomBytes, randomUUID } from "node:crypto";
import { StudySchema, EnrollSchema, MODEL_IDS } from "@clinical/shared";
import { createSession, studyInfo } from "../domain/study.js";
import { insert, one, isUnique, now, type Database } from "../lib/db.js";
import { requireAdmin } from "../lib/security.js";
import type { Settings } from "../lib/config.js";
import rawDemo from "../domain/demo.json" with { type: "json" };
import { readFile } from "node:fs/promises";
import { saveAsset, requireAssets } from "../domain/media.js";
export function demoConfig() {
  return StudySchema.parse({
    ...rawDemo,
    id: "clinician-demo-v2",
    version: "2",
    steps: [
      rawDemo.steps[0],
      {
        id: "instructions",
        title: "Instructions",
        kind: "information",
        instructions:
          "Review each case and use up to three question rounds shared between patient and lab. Submit a diagnosis and confidence whenever you are ready. Answers are final once submitted.",
      },
      rawDemo.steps.at(-1),
    ],
  });
}
export function studyRoutes(
  db: Database,
  settings: Settings,
  peer: (c: any) => string | undefined,
) {
  const app = new Hono();
  async function previewConfig() {
    if (!settings.previewStudyFile) return demoConfig();
    const raw = JSON.parse(await readFile(settings.previewStudyFile, "utf8"));
    const config = StudySchema.parse({
      ...raw,
      id: `preview-${raw.id}`,
      is_demo: true,
      prolific_study_id: null,
      completion_code: null,
    });
    await requireAssets(db, config.cases);
    return config;
  }
  app.post("/admin/media", async (c) => {
    requireAdmin(c.req.header("X-Admin-Key"), settings);
    return c.json(await saveAsset(db, await c.req.json()), 201);
  });
  app.get("/admin/models", (c) => {
    requireAdmin(c.req.header("X-Admin-Key"), settings);
    return c.json({
      models: MODEL_IDS,
      assignment: "one_model_per_session_all_roles",
    });
  });
  app.post("/admin/studies", async (c) => {
    requireAdmin(c.req.header("X-Admin-Key"), settings);
    const config = StudySchema.parse(await c.req.json());
    await requireAssets(db, config.cases);
    try {
      await insert(db, "studies", {
        id: config.id,
        config,
        active: false,
        enrolled: 0,
        created_at: now(),
      });
    } catch (e) {
      if (isUnique(e))
        throw new HTTPException(409, {
          message: "Study ID exists; create a new version",
        });
      throw e;
    }
    return c.json({ id: config.id, active: false }, 201);
  });
  app.post("/admin/studies/:studyId/:action", async (c) => {
    requireAdmin(c.req.header("X-Admin-Key"), settings);
    const action = c.req.param("action");
    if (!["activate", "pause"].includes(action)) throw new HTTPException(404);
    const s = await one(db, "SELECT * FROM studies WHERE id=$1", [
      c.req.param("studyId"),
    ]);
    if (!s) throw new HTTPException(404, { message: "Study not found" });
    if (
      action === "activate" &&
      (s.config.is_demo ||
        !s.config.prolific_study_id ||
        !s.config.completion_code ||
        !settings.openrouterKey)
    )
      throw new HTTPException(409, {
        message:
          "A live study needs approved materials, Prolific configuration and OpenRouter",
      });
    await db.query("UPDATE studies SET active=$1 WHERE id=$2", [
      action === "activate",
      s.id,
    ]);
    return c.json({ active: action === "activate" });
  });
  app.get("/studies/:studyId", async (c) => {
    const s = await one(db, "SELECT * FROM studies WHERE id=$1", [
      c.req.param("studyId"),
    ]);
    if (!s) throw new HTTPException(404, { message: "Study not found" });
    if (!s.active) requireAdmin(c.req.header("X-Admin-Key"), settings);
    return c.json(studyInfo(StudySchema.parse(s.config)));
  });
  app.post("/studies/:studyId/sessions", async (c) => {
    const body = EnrollSchema.parse(await c.req.json());
    try {
      return c.json(
        await db.tx(async (tx) => {
          const study = await one(tx, "SELECT * FROM studies WHERE id=$1", [
            c.req.param("studyId"),
          ]);
          if (!study)
            throw new HTTPException(404, { message: "Study not found" });
          if (!study.active)
            requireAdmin(c.req.header("X-Admin-Key"), settings);
          const config = StudySchema.parse(study.config);
          if (
            config.prolific_study_id &&
            body.STUDY_ID !== config.prolific_study_id
          )
            throw new HTTPException(422, {
              message: "Prolific study ID mismatch",
            });
          if (body.consent_version !== config.consent_version)
            throw new HTTPException(409, {
              message: "Consent changed; reload the study",
            });
          if (
            (
              await tx.query(
                "UPDATE studies SET enrolled=enrolled+1 WHERE id=$1 AND enrolled<$2",
                [study.id, config.max_participants],
              )
            ).rowCount !== 1
          )
            throw new HTTPException(409, { message: "Study capacity reached" });
          return createSession(tx, config, body, settings);
        }),
        201,
      );
    } catch (e) {
      if (isUnique(e))
        throw new HTTPException(409, {
          message: "Already enrolled; resume your existing session",
        });
      throw e;
    }
  });
  function localOnly(c: any) {
    if (
      settings.env !== "development" ||
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer(c) || "")
    )
      throw new HTTPException(404, { message: "Preview not available" });
    const origin = c.req.header("Origin");
    if (origin && origin !== new URL(c.req.url).origin)
      throw new HTTPException(403, { message: "Use the local preview page" });
  }
  app.get("/preview", async (c) => {
    localOnly(c);
    return c.json(studyInfo(await previewConfig()));
  });
  app.post("/preview/sessions", async (c) => {
    localOnly(c);
    const body = await c.req.json();
    if (body?.consent !== true)
      throw new HTTPException(422, { message: "Preview consent required" });
    const config = await previewConfig();
    return c.json(
      await db.tx(async (tx) => {
        await tx.query(
          "INSERT INTO studies(id,config,active,enrolled,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING",
          [config.id, config, false, 0, now()],
        );
        return createSession(
          tx,
          config,
          {
            PROLIFIC_PID: randomBytes(12).toString("hex"),
            STUDY_ID: "0".repeat(24),
            SESSION_ID: randomBytes(12).toString("hex"),
          },
          settings,
        );
      }),
      201,
    );
  });
  return app;
}
