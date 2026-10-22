import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { one, type Database } from "../lib/db.js";
import { requireAdmin } from "../lib/security.js";
import type { Settings } from "../lib/config.js";
import { sessionView } from "../domain/study.js";
import { caseView, turnView } from "../domain/clinical.js";
export function exportRoutes(db: Database, settings: Settings) {
  const app = new Hono();
  app.get("/:studyId/export", async (c) => {
    requireAdmin(c.req.header("X-Admin-Key"), settings);
    const id = c.req.param("studyId");
    const limit = Number(c.req.query("limit") || 50),
      offset = Number(c.req.query("offset") || 0);
    if (
      !Number.isInteger(limit) ||
      !Number.isInteger(offset) ||
      limit < 1 ||
      limit > 100 ||
      offset < 0
    )
      throw new HTTPException(422);
    if (!(await one(db, "SELECT id FROM studies WHERE id=$1", [id])))
      throw new HTTPException(404);
    const sessions = (
      await db.query(
        "SELECT * FROM sessions WHERE study_id=$1 ORDER BY created_at,id LIMIT $2 OFFSET $3",
        [id, limit, offset],
      )
    ).rows;
    const output = [];
    for (const s of sessions) {
      const clinical_cases = [];
      for (const a of (
        await db.query(
          "SELECT * FROM clinical_cases WHERE session_id=$1 ORDER BY step_id",
          [s.id],
        )
      ).rows.sort(
        (a, b) =>
          s.snapshot.steps.findIndex((step: any) => step.id === a.step_id) -
          s.snapshot.steps.findIndex((step: any) => step.id === b.step_id),
      )) {
        const cs = s.snapshot.cases.find((x: any) => x.id === a.case_id);
        const turns = (
          await db.query(
            "SELECT * FROM clinical_turns WHERE case_attempt_id=$1 ORDER BY created_at,id",
            [a.id],
          )
        ).rows;
        clinical_cases.push({
          ...(await caseView(db, a, s)),
          case_id: a.case_id,
          source: cs.source,
          source_id: cs.source_id,
          reference_diagnosis: cs.reference_diagnosis,
          started_at: a.started_at,
          turns: turns.map((t) => ({
            ...turnView(t),
            metadata: t.metadata_json,
            error_code: t.error_code,
          })),
        });
      }
      const runs = [];
      for (const r of (
        await db.query("SELECT * FROM runs WHERE session_id=$1", [s.id])
      ).rows) {
        const messages = (
          await db.query(
            "SELECT * FROM messages WHERE run_id=$1 ORDER BY sequence",
            [r.id],
          )
        ).rows;
        runs.push({
          ...r,
          reference_diagnosis: s.snapshot.cases.find(
            (x: any) => x.id === r.case_id,
          )?.reference_diagnosis,
          messages,
        });
      }
      const responses = (
        await db.query(
          "SELECT step_id,payload,created_at FROM responses WHERE session_id=$1",
          [s.id],
        )
      ).rows;
      const events = (
        await db.query(
          "SELECT id,step_id,event_type,data,created_at FROM study_events WHERE session_id=$1 ORDER BY created_at,id",
          [s.id],
        )
      ).rows;
      output.push({
        ...sessionView(s),
        prolific_pid: s.prolific_pid,
        prolific_study_id: s.prolific_study_id,
        prolific_session_id: s.prolific_session_id,
        model_id: s.model_id,
        condition: s.condition,
        created_at: s.created_at,
        completed_at: s.completed_at,
        consent_version: s.snapshot.consent_version,
        study_version: s.snapshot.version,
        pool_manifest: s.snapshot.pool_manifest || null,
        responses,
        runs,
        clinical_cases,
        events,
      });
    }
    return c.json({
      sessions: output,
      next_offset: sessions.length === limit ? offset + limit : null,
    });
  });
  return app;
}
