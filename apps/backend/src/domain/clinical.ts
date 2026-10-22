import { randomUUID } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import type { CaseView, TurnView, Draft } from "@clinical/shared";
import { ClinicalQuestionSchema, DiagnosisSchema } from "@clinical/shared";
import type { z } from "zod";
import { one, insert, now, type Queryable, type Row } from "../lib/db.js";
import { event, getAttempt, reserveRevision, sessionView } from "./study.js";
export function turnView(t: Row): TurnView {
  return {
    id: t.id,
    round_number: t.round_number,
    target: t.target,
    question: t.question,
    tests: t.tests,
    status: t.status,
    response: t.response,
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
  return {
    id: a.id,
    step_id: a.step_id,
    title: c.title,
    opening: c.opening,
    available_tests: Object.keys(c.labs),
    rounds_used: a.rounds_used,
    max_rounds: 3,
    can_ask:
      a.diagnosis === null && a.rounds_used < 3 && turns.length < 6 && !pending,
    pending,
    turns: turns.map((t) => ({
      ...turnView(t),
      images:
        t.target === "lab" && t.status === "succeeded"
          ? (c.media || [])
              .filter((m: any) => t.tests.includes(m.test))
              .map((m: any) => ({
                url: `/api/cases/${a.step_id}/media/${m.asset_id}`,
                caption: m.caption,
              }))
          : [],
    })),
    diagnosis: a.diagnosis,
    confidence: a.confidence,
    completed_at: a.completed_at,
    draft: {
      question: "",
      tests: [],
      diagnosis: "",
      confidence: 50,
      ...saved?.data,
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
      previous.target !== body.target ||
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
      message: "Wait for the response or submit your diagnosis",
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
      a.diagnosis === body.diagnosis &&
      a.confidence === body.confidence
    )
      return sessionView(s);
    throw new HTTPException(409, { message: "Diagnosis already submitted" });
  }
  await getAttempt(db, s, stepId);
  await reserveRevision(db, s, body.revision);
  if ((await caseView(db, a, s)).pending)
    throw new HTTPException(409, { message: "Wait for the current response" });
  await db.query(
    "UPDATE clinical_cases SET diagnosis=$1,confidence=$2,diagnosis_request_id=$3,started_at=COALESCE(started_at,$4),completed_at=$4 WHERE id=$5",
    [body.diagnosis, body.confidence, body.request_id, now(), a.id],
  );
  await db.query("UPDATE sessions SET step_index=step_index+1 WHERE id=$1", [
    s.id,
  ]);
  s.step_index++;
  await event(db, s, stepId, "diagnosis_submitted", {
    request_id: body.request_id,
    rounds_used: a.rounds_used,
    confidence: body.confidence,
  });
  return sessionView(s);
}
