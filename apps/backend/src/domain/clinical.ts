import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { HTTPException } from "hono/http-exception";
import type { CaseView, TurnView, Draft } from "@clinical/shared";
import {
  ClinicalQuestionSchema,
  DiagnosisSchema,
  CLINICAL_ROUNDS,
  CLINICAL_PROTOCOL,
  emptyDiagnoses,
  confidenceDraft,
  CONFIDENCE_SCALE,
} from "@clinical/shared";
import type { z } from "zod";
import { one, insert, now, type Queryable, type Row } from "../lib/db.js";
import { event, getAttempt, reserveRevision, sessionView } from "./study.js";
import { releasedMedia } from "./lab.js";
import { enqueueJudgment } from "./judge.js";
export function turnView(t: Row): TurnView {
  return {
    id: t.id,
    round_number: t.round_number,
    target: t.metadata_json?.resolved_target || t.target,
    question: t.question,
    tests: t.tests,
    status: t.status,
    response: t.response,
    responses:
      t.status !== "succeeded"
        ? []
        : t.metadata_json?.responses
          ? t.metadata_json.responses.map((r: Row) => ({
              target: r.target,
              response: r.response,
            }))
          : [{ target: t.target, response: t.response }],
    images: [],
    created_at: t.created_at,
    finished_at: t.finished_at,
  };
}
export async function caseView(
  db: Queryable,
  a: Row,
  s: Row,
): Promise<CaseView> {
  const c = s.snapshot.cases.find((x: Row) => x.id === a.case_id);
  const turns = (
    await db.query(
      "SELECT * FROM clinical_turns WHERE case_attempt_id=$1 ORDER BY created_at,id",
      [a.id],
    )
  ).rows;
  const saved = await one(
    db,
    "SELECT * FROM task_drafts WHERE session_id=$1 AND step_id=$2",
    [s.id, a.step_id],
  );
  const pending = turns.some((t) => ["queued", "running"].includes(t.status));
  const completed = turns.filter((t) => t.status === "succeeded").length;
  const recent = turns.filter((t) => t.created_at > now() - 600);
  // The submission event freezes the protocol of completed cases even when an
  // active session is upgraded. Older submissions predate that event metadata.
  const submission =
    a.diagnosis === null
      ? null
      : await one(
          db,
          "SELECT data FROM study_events WHERE session_id=$1 AND step_id=$2 AND event_type='diagnosis_submitted' ORDER BY created_at DESC LIMIT 1",
          [s.id, a.step_id],
        );
  const protocol =
    a.diagnosis === null
      ? CLINICAL_PROTOCOL
      : submission?.data?.protocol_version ||
        (!a.diagnoses_json
          ? "legacy-single-diagnosis"
          : a.confidence_scale !== CONFIDENCE_SCALE
            ? "patient-only-top3-v2"
            : a.diagnoses_json.length > 1
              ? "patient-only-top3-likert-v3"
              : "patient-only-top1-likert-v4");
  const maxRounds =
    a.diagnosis === null
      ? CLINICAL_ROUNDS
      : submission?.data?.max_rounds ||
        (protocol === CLINICAL_PROTOCOL
          ? CLINICAL_ROUNDS
          : protocol === "legacy-single-diagnosis"
            ? Math.max(3, completed)
            : 5);
  const diagnoses = confidenceDraft(
    saved?.data?.diagnoses ||
      (saved?.data?.diagnosis
        ? [
            {
              diagnosis: saved.data.diagnosis,
              confidence: 4,
            },
            ...emptyDiagnoses().slice(1),
          ]
        : emptyDiagnoses()),
  );
  return {
    id: a.id,
    step_id: a.step_id,
    title: c.title,
    opening: c.opening,
    available_tests: [],
    rounds_used: a.rounds_used,
    max_rounds: maxRounds,
    can_ask:
      a.diagnosis === null &&
      a.rounds_used < maxRounds &&
      recent.length < 6 &&
      !pending,
    rounds_completed: completed,
    can_diagnose: a.diagnosis === null && completed >= maxRounds && !pending,
    retry_after_seconds:
      recent.length >= 6
        ? Math.max(1, Math.ceil(recent[0].created_at + 600 - now()))
        : 0,
    pending,
    turns: turns.map((t) => ({
      ...turnView(t),
      images: releasedMedia(c, t).map((m) => ({
        url: `/api/cases/${a.step_id}/media/${m.asset_id}`,
        caption: m.caption,
      })),
    })),
    diagnosis: a.diagnosis,
    confidence: a.confidence,
    diagnoses: a.diagnoses_json || null,
    confidence_scale:
      a.diagnosis === null
        ? CONFIDENCE_SCALE
        : a.confidence_scale || "percent_0_100",
    protocol_version: protocol,
    completed_at: a.completed_at,
    draft: {
      question: "",
      lab_question: "",
      tests: [],
      confidence: 50,
      ...saved?.data,
      diagnosis: "",
      diagnoses: completed >= maxRounds ? diagnoses : emptyDiagnoses(),
      revision: saved?.revision || 0,
    } as Draft,
  };
}
export async function queueQuestion(
  db: Queryable,
  s: Row,
  stepId: string,
  body: z.infer<typeof ClinicalQuestionSchema>,
) {
  let a = await getAttempt(db, s, stepId, false);
  const previous = await one(
    db,
    "SELECT * FROM clinical_turns WHERE case_attempt_id=$1 AND request_id=$2",
    [a.id, body.request_id],
  );
  if (previous) {
    if (
      !["auto", "patient"].includes(previous.target) ||
      body.target !== "patient" ||
      previous.question !== body.question ||
      JSON.stringify(previous.tests) !== JSON.stringify(body.tests)
    )
      throw new HTTPException(409, { message: "Request ID already used" });
    return { session: sessionView(s), case: await caseView(db, a, s) };
  }
  await getAttempt(db, s, stepId);
  await reserveRevision(db, s, body.revision);
  a = (await one(db, "SELECT * FROM clinical_cases WHERE id=$1", [a.id]))!;
  const view = await caseView(db, a, s);
  if (!view.can_ask)
    throw new HTTPException(409, {
      message:
        "Wait for the response, complete all three rounds, or retry after the temporary request limit",
    });
  if (body.tests.some((t) => !view.available_tests.includes(t)))
    throw new HTTPException(422, { message: "Select available tests" });
  await db.query(
    "UPDATE clinical_cases SET rounds_used=rounds_used+1,started_at=COALESCE(started_at,$1) WHERE id=$2",
    [now(), a.id],
  );
  a.rounds_used++;
  await insert(db, "clinical_turns", {
    id: randomUUID(),
    case_attempt_id: a.id,
    request_id: body.request_id,
    round_number: a.rounds_used,
    target: body.target,
    question: body.question,
    tests: body.tests,
    status: "queued",
    response: null,
    metadata_json: null,
    error_code: null,
    worker_id: null,
    lease_until: null,
    created_at: now(),
    finished_at: null,
  });
  await event(db, s, stepId, "question_submitted", {
    round: a.rounds_used,
    target: body.target,
    request_id: body.request_id,
  });
  return { session: sessionView(s), case: await caseView(db, a, s) };
}
export async function diagnose(
  db: Queryable,
  s: Row,
  stepId: string,
  body: z.infer<typeof DiagnosisSchema>,
) {
  const a = await getAttempt(db, s, stepId, false);
  if (a.diagnosis !== null) {
    if (
      a.diagnosis_request_id === body.request_id &&
      isDeepStrictEqual(a.diagnoses_json, body.diagnoses)
    )
      return sessionView(s);
    throw new HTTPException(409, { message: "Diagnosis already submitted" });
  }
  await getAttempt(db, s, stepId);
  await reserveRevision(db, s, body.revision);
  if (!(await caseView(db, a, s)).can_diagnose)
    throw new HTTPException(409, {
      message: "Complete all three question rounds before entering diagnoses",
    });
  await db.query(
    "UPDATE clinical_cases SET diagnosis=$1,confidence=$2,diagnosis_request_id=$3,started_at=COALESCE(started_at,$4),completed_at=$4,diagnoses_json=$6,confidence_scale=$7 WHERE id=$5",
    [
      body.diagnoses[0].diagnosis,
      body.diagnoses[0].confidence,
      body.request_id,
      now(),
      a.id,
      body.diagnoses,
      CONFIDENCE_SCALE,
    ],
  );
  await db.query("UPDATE sessions SET step_index=step_index+1 WHERE id=$1", [
    s.id,
  ]);
  s.step_index++;
  await enqueueJudgment(
    db,
    { caseAttemptId: a.id },
    s.snapshot.cases.find((c: Row) => c.id === a.case_id),
    body.diagnoses,
    CONFIDENCE_SCALE,
  );
  await event(db, s, stepId, "diagnosis_submitted", {
    request_id: body.request_id,
    rounds_used: a.rounds_used,
    diagnoses: body.diagnoses,
    protocol_version: CLINICAL_PROTOCOL,
    max_rounds: CLINICAL_ROUNDS,
    confidence_scale: CONFIDENCE_SCALE,
  });
  return sessionView(s);
}
