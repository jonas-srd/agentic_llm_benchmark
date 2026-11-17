import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { one, type Database } from "../lib/db.js";
import { requireAdmin } from "../lib/security.js";
import type { Settings } from "../lib/config.js";
import { sessionView } from "../domain/study.js";
import { caseView, turnView } from "../domain/clinical.js";
import { SUPPORT_MODEL } from "../domain/protocol.js";
import { patientRecord, FACT_PACK_VERSION } from "../domain/facts.js";
import { POST_SURVEY_ID, isPostSurvey } from "@clinical/shared";
function duration(rows: any[]) {
  return {
    elapsed_ms: rows.reduce((n, r) => n + r.elapsed_ms, 0),
    active_ms: rows.reduce((n, r) => n + r.active_ms, 0),
    segments: rows.length,
  };
}
export function exportRoutes(db: Database, settings: Settings) {
  const app = new Hono();
  app.post("/:studyId/judgments/:judgmentId/retry", async (c) => {
    requireAdmin(c.req.header("X-Admin-Key"), settings);
    const changed = await db.query(
      `UPDATE diagnosis_judgments SET status='queued',worker_id=NULL,lease_until=NULL,error_code=NULL,result=NULL,finished_at=NULL
      WHERE id=$1 AND status IN ('failed','interrupted') AND (
        case_attempt_id IN (SELECT a.id FROM clinical_cases a JOIN sessions s ON s.id=a.session_id WHERE s.study_id=$2)
        OR run_id IN (SELECT r.id FROM runs r JOIN sessions s ON s.id=r.session_id WHERE s.study_id=$2))`,
      [c.req.param("judgmentId"), c.req.param("studyId")],
    );
    if (changed.rowCount !== 1)
      throw new HTTPException(409, {
        message: "No failed or interrupted judgment in this study",
      });
    return c.json({ status: "queued" }, 202);
  });
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
      const timings = (
        await db.query(
          "SELECT * FROM study_timings WHERE session_id=$1 ORDER BY created_at,id",
          [s.id],
        )
      ).rows;
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
        const view = await caseView(db, a, s);
        clinical_cases.push({
          ...view,
          case_id: a.case_id,
          source: cs.source,
          source_id: cs.source_id,
          reference_diagnosis: cs.reference_diagnosis,
          accepted_alternatives: cs.accepted_alternatives || [],
          fact_pack: patientRecord(cs).facts,
          fact_pack_version: FACT_PACK_VERSION,
          judgment:
            (await one(
              db,
              "SELECT * FROM diagnosis_judgments WHERE case_attempt_id=$1",
              [a.id],
            )) || null,
          started_at: a.started_at,
          page_timing: duration(
            timings.filter(
              (t) => t.step_id === a.step_id && t.phase === "page",
            ),
          ),
          diagnosis_timing: duration(
            timings.filter(
              (t) => t.step_id === a.step_id && t.phase === "diagnosis",
            ),
          ),
          round_timing: Array.from(
            // Keep every historical round when an unfinished five-round case
            // was already beyond the new limit at the time of migration.
            {
              length: Math.max(
                view.max_rounds,
                ...turns.map((t) => t.round_number),
              ),
            },
            (_, i) => i + 1,
          ).map((round) => ({
            round_number: round,
            preparation: duration(
              timings.filter(
                (t) =>
                  t.step_id === a.step_id &&
                  t.phase === "round" &&
                  t.round_number === round,
              ),
            ),
            response_view: duration(
              timings.filter(
                (t) =>
                  t.step_id === a.step_id &&
                  t.phase === "response" &&
                  t.round_number === round,
              ),
            ),
            server_wait_ms: turns
              .filter((t) => t.round_number === round && t.finished_at !== null)
              .reduce(
                (n, t) =>
                  n +
                  Math.max(
                    0,
                    Math.round((t.finished_at - t.created_at) * 1000),
                  ),
                0,
              ),
          })),
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
          judgment:
            (await one(
              db,
              "SELECT * FROM diagnosis_judgments WHERE run_id=$1",
              [r.id],
            )) || null,
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
        support_model_id: SUPPORT_MODEL,
        condition: s.condition,
        created_at: s.created_at,
        completed_at: s.completed_at,
        consent_version: s.snapshot.consent_version,
        study_version: s.snapshot.version,
        pool_manifest: s.snapshot.pool_manifest || null,
        responses,
        post_survey: s.snapshot.post_survey_version
          ? {
              version: s.snapshot.post_survey_version,
              questions: s.snapshot.steps
                .filter((step: any) => isPostSurvey(step.id))
                .flatMap((step: any) => step.questions),
              answers: Object.assign(
                {},
                ...responses
                  .filter((r) => isPostSurvey(r.step_id))
                  .map((r) => r.payload.answers),
              ),
              pages: s.snapshot.steps
                .filter((step: any) => isPostSurvey(step.id))
                .map((step: any) => ({
                  step_id: step.id,
                  title: step.title,
                  questions: step.questions,
                  response:
                    responses.find((r) => r.step_id === step.id) || null,
                  timing: duration(
                    timings.filter(
                      (t) => t.step_id === step.id && t.phase === "page",
                    ),
                  ),
                })),
              // Retain the original first-page response field for v1 consumers.
              response:
                responses.find((r) => r.step_id === POST_SURVEY_ID) || null,
              timing: duration(
                timings.filter(
                  (t) => isPostSurvey(t.step_id) && t.phase === "page",
                ),
              ),
            }
          : null,
        runs,
        clinical_cases,
        events,
        page_timings: [
          ...new Set(
            timings.filter((t) => t.phase === "page").map((t) => t.step_id),
          ),
        ].map((step_id) => ({
          step_id,
          ...duration(
            timings.filter((t) => t.step_id === step_id && t.phase === "page"),
          ),
        })),
        timing_segments: timings,
      });
    }
    return c.json({
      sessions: output,
      next_offset: sessions.length === limit ? offset + limit : null,
    });
  });
  return app;
}
