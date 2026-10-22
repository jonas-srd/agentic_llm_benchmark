import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  AnswerSchema,
  ClinicalQuestionSchema,
  DiagnosisSchema,
  DraftSchema,
  EventsSchema,
} from "@clinical/shared";
import { one, insert, now, type Database } from "../lib/db.js";
import { owned } from "../lib/security.js";
import type { Settings } from "../lib/config.js";
import {
  sessionView,
  currentStep,
  reserveRevision,
  validateAnswers,
  event,
  getAttempt,
} from "../domain/study.js";
import { caseView, queueQuestion, diagnose } from "../domain/clinical.js";
export function sessionRoutes(db: Database, settings: Settings) {
  const app = new Hono();
  app.get("/:sessionId/cases/:stepId/media/:assetId", async (c) => {
    const s = await owned(
      db,
      c.req.param("sessionId"),
      c.req.header("Authorization"),
      settings,
    );
    const a = await getAttempt(db, s, c.req.param("stepId"), false);
    const spec = s.snapshot.cases.find((x: any) => x.id === a.case_id);
    const media = (spec.media || []).find(
      (m: any) => m.asset_id === c.req.param("assetId"),
    );
    const turns = (
      await db.query(
        "SELECT tests FROM clinical_turns WHERE case_attempt_id=$1 AND target='lab' AND status='succeeded'",
        [a.id],
      )
    ).rows;
    if (!media || !turns.some((t) => t.tests.includes(media.test)))
      throw new HTTPException(404);
    const asset = await one(db, "SELECT * FROM case_media WHERE id=$1", [
      media.asset_id,
    ]);
    if (!asset) throw new HTTPException(404);
    c.header("Content-Type", asset.mime_type);
    c.header("Content-Disposition", "inline");
    return c.body(new Uint8Array(Buffer.from(asset.data_base64, "base64")));
  });
  app.get("/:sessionId", async (c) =>
    c.json(
      sessionView(
        await owned(
          db,
          c.req.param("sessionId"),
          c.req.header("Authorization"),
          settings,
        ),
      ),
    ),
  );
  app.post("/:sessionId/steps/:stepId", async (c) => {
    const body = AnswerSchema.parse(await c.req.json());
    return c.json(
      await db.tx(async (tx) => {
        const s = await owned(
          tx,
          c.req.param("sessionId"),
          c.req.header("Authorization"),
          settings,
        );
        const stepId = c.req.param("stepId");
        const payload = {
          answers: body.answers,
          include_in_analysis: body.include_in_analysis,
        };
        const prior = await one(
          tx,
          "SELECT * FROM responses WHERE session_id=$1 AND step_id=$2",
          [s.id, stepId],
        );
        if (prior) {
          if (
            prior.request_id === body.request_id &&
            isDeepStrictEqual(prior.payload, payload)
          )
            return sessionView(s);
          throw new HTTPException(409, { message: "Step already submitted" });
        }
        const step = currentStep(s);
        if (!step || step.id !== stepId || s.status !== "active")
          throw new HTTPException(409, {
            message: "Submit the current step in order",
          });
        if (step.kind === "diagnosis")
          throw new HTTPException(409, {
            message: "Submit a diagnosis through the case endpoint",
          });
        validateAnswers(step, body.answers);
        if (
          s.snapshot.workflow === "clinician" &&
          body.answers.physician === false
        )
          throw new HTTPException(422, {
            message: "This study is for qualified medical doctors",
          });
        if (
          (step.kind === "final_check") !==
          (body.include_in_analysis !== null)
        )
          throw new HTTPException(422, {
            message: "Analysis inclusion belongs to the final check",
          });
        if (step.kind === "simulation") {
          const run = await one(
            tx,
            "SELECT * FROM runs WHERE session_id=$1 AND step_id=$2",
            [s.id, stepId],
          );
          if (run?.status !== "succeeded")
            throw new HTTPException(409, {
              message: "Complete the simulation first",
            });
        }
        await reserveRevision(tx, s, body.revision);
        s.step_index++;
        if (step.kind === "final_check") {
          s.status = "completed";
          s.completed_at = now();
          s.include_in_analysis = body.include_in_analysis;
        }
        await tx.query(
          "UPDATE sessions SET step_index=$1,status=$2,completed_at=$3,include_in_analysis=$4 WHERE id=$5",
          [s.step_index, s.status, s.completed_at, s.include_in_analysis, s.id],
        );
        await insert(tx, "responses", {
          id: randomUUID(),
          session_id: s.id,
          step_id: stepId,
          request_id: body.request_id,
          payload,
          created_at: now(),
        });
        await event(tx, s, stepId, "step_submitted", {
          request_id: body.request_id,
        });
        return sessionView(s);
      }),
    );
  });
  app.get("/:sessionId/cases/:stepId", async (c) =>
    c.json(
      await db.tx(async (tx) => {
        const s = await owned(
          tx,
          c.req.param("sessionId"),
          c.req.header("Authorization"),
          settings,
        );
        const a = await getAttempt(tx, s, c.req.param("stepId"));
        await tx.query(
          "UPDATE clinical_cases SET started_at=COALESCE(started_at,$1) WHERE id=$2",
          [now(), a.id],
        );
        return caseView(tx, a, s);
      }),
    ),
  );
  app.post("/:sessionId/cases/:stepId/questions", async (c) => {
    const body = ClinicalQuestionSchema.parse(await c.req.json());
    return c.json(
      await db.tx(async (tx) =>
        queueQuestion(
          tx,
          await owned(
            tx,
            c.req.param("sessionId"),
            c.req.header("Authorization"),
            settings,
          ),
          c.req.param("stepId"),
          body,
        ),
      ),
      202,
    );
  });
  app.post("/:sessionId/cases/:stepId/diagnosis", async (c) => {
    const body = DiagnosisSchema.parse(await c.req.json());
    return c.json(
      await db.tx(async (tx) =>
        diagnose(
          tx,
          await owned(
            tx,
            c.req.param("sessionId"),
            c.req.header("Authorization"),
            settings,
          ),
          c.req.param("stepId"),
          body,
        ),
      ),
    );
  });
  app.post("/:sessionId/cases/:stepId/draft", async (c) => {
    const body = DraftSchema.parse(await c.req.json());
    return c.json(
      await db.tx(async (tx) => {
        const s = await owned(
          tx,
          c.req.param("sessionId"),
          c.req.header("Authorization"),
          settings,
        );
        const a = await getAttempt(tx, s, c.req.param("stepId"));
        const lock = await tx.query(
          "UPDATE clinical_cases SET rounds_used=rounds_used WHERE id=$1 AND diagnosis IS NULL",
          [a.id],
        );
        if (lock.rowCount !== 1)
          throw new HTTPException(409, { message: "Case already submitted" });
        const { revision, ...data } = body;
        const changed =
          revision === 0
            ? await tx.query(
                "INSERT INTO task_drafts(session_id,step_id,data,revision,updated_at) VALUES($1,$2,$3,1,$4) ON CONFLICT(session_id,step_id) DO NOTHING",
                [s.id, a.step_id, data, now()],
              )
            : await tx.query(
                "UPDATE task_drafts SET data=$1,revision=revision+1,updated_at=$2 WHERE session_id=$3 AND step_id=$4 AND revision=$5",
                [data, now(), s.id, a.step_id, revision],
              );
        if (changed.rowCount !== 1) {
          const saved = await one(
            tx,
            "SELECT data,revision FROM task_drafts WHERE session_id=$1 AND step_id=$2",
            [s.id, a.step_id],
          );
          // A lost HTTP response must not turn an identical retry into a conflict.
          if (
            saved?.revision === revision + 1 &&
            isDeepStrictEqual(saved.data, data)
          )
            return { ...data, revision: saved.revision };
          throw new HTTPException(409, {
            message: "Draft changed in another tab; reload before editing",
          });
        }
        return { ...data, revision: revision + 1 };
      }),
    );
  });
  app.post("/:sessionId/events", async (c) => {
    const body = EventsSchema.parse(await c.req.json());
    return c.json(
      await db.tx(async (tx) => {
        const s = await owned(
          tx,
          c.req.param("sessionId"),
          c.req.header("Authorization"),
          settings,
        );
        const allowed = s.snapshot.steps
          .slice(0, s.step_index + 1)
          .map((x: any) => x.id);
        if (body.events.some((e) => !allowed.includes(e.step_id)))
          throw new HTTPException(422, {
            message: "Unknown or unvisited step",
          });
        for (const e of body.events)
          await tx.query(
            "INSERT INTO study_events(id,session_id,step_id,event_type,data,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING",
            [
              e.id,
              s.id,
              e.step_id,
              e.type,
              { client_ts: e.client_ts, source: "client" },
              now(),
            ],
          );
        return { accepted: body.events.length };
      }),
    );
  });
  app.post("/:sessionId/runs", async (c) =>
    c.json(
      await db.tx(async (tx) => {
        const s = await owned(
          tx,
          c.req.param("sessionId"),
          c.req.header("Authorization"),
          settings,
        );
        const step = currentStep(s);
        if (s.status !== "active" || step?.kind !== "simulation")
          throw new HTTPException(409, {
            message: "No simulation at the current step",
          });
        await tx.query(
          "INSERT INTO runs(id,session_id,step_id,case_id,status,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(session_id,step_id) DO NOTHING",
          [randomUUID(), s.id, step.id, step.case_id, "queued", now()],
        );
        const run = (await one(
          tx,
          "SELECT * FROM runs WHERE session_id=$1 AND step_id=$2",
          [s.id, step.id],
        ))!;
        return { id: run.id, status: run.status };
      }),
      202,
    ),
  );
  app.get("/:sessionId/runs/:runId", async (c) => {
    const s = await owned(
      db,
      c.req.param("sessionId"),
      c.req.header("Authorization"),
      settings,
    );
    const run = await one(
      db,
      "SELECT * FROM runs WHERE id=$1 AND session_id=$2",
      [c.req.param("runId"), s.id],
    );
    if (!run) throw new HTTPException(404);
    const messages = (
      await db.query(
        "SELECT sequence,role,content FROM messages WHERE run_id=$1 ORDER BY sequence",
        [run.id],
      )
    ).rows;
    return c.json({
      id: run.id,
      status: run.status,
      result: run.result,
      error_code: run.error_code,
      messages,
    });
  });
  return app;
}
