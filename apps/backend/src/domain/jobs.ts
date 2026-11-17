import { randomUUID } from "node:crypto";
import type { CaseSpec } from "@clinical/shared";
import { currentInterviewerModel } from "@clinical/shared";
import { one, insert, now, type Database, type Row } from "../lib/db.js";
import { ProviderError, type Provider } from "../lib/openrouter.js";
import { runSimulation } from "./agents.js";
import { answerPatient } from "./patient.js";
import {
  enqueueJudgment,
  judgeDiagnoses,
  JUDGE_PROMPT_VERSION,
} from "./judge.js";
export const LEASE_SECONDS = 180;
type Queue = "clinical_turns" | "runs" | "diagnosis_judgments";
export async function claimJob(
  db: Database,
  worker: string,
  table: Queue,
): Promise<string | null> {
  return db.tx(async (tx) => {
    const expired = (
      await tx.query(
        `SELECT * FROM ${table} WHERE status='running' AND lease_until<$1`,
        [now()],
      )
    ).rows;
    for (const row of expired) {
      const changed = await tx.query(
        `UPDATE ${table} SET status='interrupted',error_code='worker_lease_expired',finished_at=$1,lease_until=NULL WHERE id=$2 AND status='running' AND lease_until<$1`,
        [now(), row.id],
      );
      if (changed.rowCount && table === "clinical_turns")
        await tx.query(
          "UPDATE clinical_cases SET rounds_used=rounds_used-1 WHERE id=$1",
          [row.case_attempt_id],
        );
    }
    const candidate = await one(
      tx,
      `SELECT id FROM ${table} WHERE status='queued' ORDER BY created_at,id LIMIT 1${db.postgres ? " FOR UPDATE SKIP LOCKED" : ""}`,
    );
    if (!candidate) return null;
    const changed = await tx.query(
      `UPDATE ${table} SET status='running',worker_id=$1,lease_until=$2 WHERE id=$3 AND status='queued'`,
      [worker, now() + LEASE_SECONDS, candidate.id],
    );
    return changed.rowCount === 1 ? candidate.id : null;
  });
}
export async function processTurn(
  db: Database,
  provider: Provider,
  id: string,
  worker: string,
) {
  const turn = await one(db, "SELECT * FROM clinical_turns WHERE id=$1", [id]);
  if (
    !turn ||
    turn.status !== "running" ||
    turn.worker_id !== worker ||
    turn.lease_until <= now()
  )
    return;
  const a = (await one(db, "SELECT * FROM clinical_cases WHERE id=$1", [
    turn.case_attempt_id,
  ]))!;
  const s = (await one(db, "SELECT * FROM sessions WHERE id=$1", [
    a.session_id,
  ]))!;
  const c: CaseSpec = s.snapshot.cases.find(
    (c: CaseSpec) => c.id === a.case_id,
  );
  const history = (
    await db.query(
      "SELECT * FROM clinical_turns WHERE case_attempt_id=$1 AND status='succeeded' ORDER BY created_at,id",
      [a.id],
    )
  ).rows;
  async function renew() {
    const r = await db.query(
      "UPDATE clinical_turns SET lease_until=$1 WHERE id=$2 AND worker_id=$3 AND status='running' AND lease_until>$4",
      [now() + LEASE_SECONDS, id, worker, now()],
    );
    if (r.rowCount !== 1) throw new ProviderError("worker_lease_lost");
  }
  let status = "succeeded",
    response: string | null = null,
    metadata: Row | null = null,
    errorCode: string | null = null;
  try {
    await renew();
    const reply = await answerPatient(
      provider,
      c,
      turn.question || turn.tests.join(", "),
      history.map((t) => ({
        question: t.question || t.tests.join(", "),
        answer: t.response,
      })),
    );
    response = reply.response;
    metadata = {
      ...reply.metadata,
      responses: [{ target: "patient", response: reply.response }],
    };
  } catch (error) {
    status = "failed";
    errorCode =
      error instanceof ProviderError
        ? error.message
        : "invalid_agent_output_or_processing_error";
  }
  await db.tx(async (tx) => {
    const changed = await tx.query(
      "UPDATE clinical_turns SET status=$1,response=$2,metadata_json=$3,error_code=$4,finished_at=$5,lease_until=NULL WHERE id=$6 AND worker_id=$7 AND status='running' AND lease_until>$5",
      [status, response, metadata, errorCode, now(), id, worker],
    );
    if (changed.rowCount && status !== "succeeded")
      await tx.query(
        "UPDATE clinical_cases SET rounds_used=rounds_used-1 WHERE id=$1",
        [a.id],
      );
  });
}
export async function processRun(
  db: Database,
  provider: Provider,
  id: string,
  worker: string,
) {
  const run = await one(db, "SELECT * FROM runs WHERE id=$1", [id]);
  if (
    !run ||
    run.status !== "running" ||
    run.worker_id !== worker ||
    run.lease_until <= now()
  )
    return;
  const s = (await one(db, "SELECT * FROM sessions WHERE id=$1", [
    run.session_id,
  ]))!;
  const c = s.snapshot.cases.find((c: CaseSpec) => c.id === run.case_id);
  let sequence = 0;
  async function renew() {
    const r = await db.query(
      "UPDATE runs SET lease_until=$1 WHERE id=$2 AND worker_id=$3 AND status='running' AND lease_until>$4",
      [now() + LEASE_SECONDS, id, worker, now()],
    );
    if (r.rowCount !== 1) throw new ProviderError("worker_lease_lost");
  }
  let status = "succeeded",
    result: Awaited<ReturnType<typeof runSimulation>> | null = null,
    errorCode: string | null = null;
  try {
    result = await runSimulation(
      db,
      c,
      currentInterviewerModel(s.model_id),
      provider,
      async (role, reply, promptVersion) => {
        await renew();
        await insert(db, "messages", {
          id: randomUUID(),
          run_id: id,
          sequence: sequence++,
          role,
          ...reply,
          prompt_version: promptVersion,
          created_at: now(),
        });
      },
      renew,
    );
  } catch (error) {
    status = "failed";
    errorCode =
      error instanceof ProviderError
        ? error.message
        : "invalid_agent_output_or_processing_error";
  }
  await db.tx(async (tx) => {
    const changed = await tx.query(
      "UPDATE runs SET status=$1,result=$2,error_code=$3,finished_at=$4,lease_until=NULL WHERE id=$5 AND worker_id=$6 AND status='running' AND lease_until>$4",
      [status, result, errorCode, now(), id, worker],
    );
    if (changed.rowCount && result)
      await enqueueJudgment(
        tx,
        { runId: id },
        c,
        result.diagnoses,
        result.confidence_scale,
      );
  });
}

export async function processJudgment(
  db: Database,
  provider: Provider,
  id: string,
  worker: string,
) {
  const job = await one(db, "SELECT * FROM diagnosis_judgments WHERE id=$1", [
    id,
  ]);
  if (
    !job ||
    job.status !== "running" ||
    job.worker_id !== worker ||
    job.lease_until <= now()
  )
    return;
  async function renew() {
    const r = await db.query(
      "UPDATE diagnosis_judgments SET lease_until=$1 WHERE id=$2 AND worker_id=$3 AND status='running' AND lease_until>$4",
      [now() + LEASE_SECONDS, id, worker, now()],
    );
    if (r.rowCount !== 1) throw new ProviderError("worker_lease_lost");
  }
  let status = "succeeded",
    result: unknown = null,
    errorCode: string | null = null;
  try {
    if (job.prompt_version !== JUDGE_PROMPT_VERSION)
      throw new Error("unsupported_judge_version");
    result = await judgeDiagnoses(provider, job.payload, renew);
  } catch (error) {
    status = "failed";
    errorCode =
      error instanceof ProviderError
        ? error.message
        : "invalid_judge_output_or_processing_error";
  }
  await db.query(
    "UPDATE diagnosis_judgments SET status=$1,result=$2,error_code=$3,finished_at=$4,lease_until=NULL WHERE id=$5 AND worker_id=$6 AND status='running' AND lease_until>$4",
    [status, result, errorCode, now(), id, worker],
  );
}
