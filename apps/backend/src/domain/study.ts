import { randomInt, randomUUID } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import type {
  StudyConfig,
  StudyStep,
  SessionView,
  StudyInfo,
} from "@clinical/shared";
import {
  ELIGIBILITY_CONFIRMATION,
  PARTICIPANT_INFO_VERSION,
  isPostSurvey,
  questionVisible,
  CONFIDENCE_SCALE,
} from "@clinical/shared";
import {
  allocationScope,
  caseKey,
  clinicianProtocol,
  SUPPORT_MODEL,
  CLINICIAN_INSTRUCTIONS,
} from "./protocol.js";
import { one, insert, now, type Queryable, type Row } from "../lib/db.js";
import { issueToken } from "../lib/security.js";
import type { Settings } from "../lib/config.js";
export function shuffle<T>(input: T[]): T[] {
  const result = [...input];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
export function assignCases(
  config: StudyConfig,
  available = config.cases,
): StudyConfig {
  const snapshot = structuredClone(clinicianProtocol(config));
  if (config.workflow !== "clinician") return snapshot;
  const sources = [...new Set(config.cases.map((c) => c.source))];
  const groups = sources.map((source) =>
    shuffle(available.filter((c) => c.source === source)),
  );
  if (
    available.length < config.cases_per_participant ||
    groups.some((g) => g.length === 0) ||
    config.cases_per_participant < sources.length
  )
    throw new HTTPException(409, {
      message:
        "No complete set of unassigned cases is available. Please contact the study team.",
    });
  const selected = groups.map((g) => g.pop()!);
  const counts = groups.map(() => 1);
  const maximum = Math.ceil(config.cases_per_participant / sources.length);
  while (selected.length < config.cases_per_participant) {
    const eligible = groups
      .map((g, i) => ({ group: g, i }))
      .filter(({ group, i }) => group.length > 0 && counts[i] < maximum);
    if (!eligible.length)
      throw new HTTPException(409, {
        message: "No balanced set of unassigned cases remains",
      });
    const largest = Math.max(...eligible.map(({ group }) => group.length));
    const chosen = shuffle(
      eligible.filter(({ group }) => group.length === largest),
    )[0];
    counts[chosen.i]++;
    selected.push(chosen.group.pop()!);
  }
  snapshot.cases = shuffle(selected);
  const steps: StudyStep[] = snapshot.cases.map((c, i) => ({
    id: `clinical-${i + 1}`,
    title: `Patient case ${i + 1}`,
    kind: "diagnosis",
    instructions: "",
    questions: [],
    case_id: c.id,
  }));
  snapshot.steps = [
    ...snapshot.steps.slice(0, -1).filter((step) => !isPostSurvey(step.id)),
    ...steps,
    ...snapshot.steps.filter((step) => isPostSurvey(step.id)),
    snapshot.steps.at(-1)!,
  ];
  return snapshot;
}
export function currentStep(session: Row): StudyStep | null {
  return session.snapshot.steps[session.step_index] || null;
}
export function sessionView(s: Row): SessionView {
  const step = currentStep(s);
  const { case_id, ...visible } = step || {};
  if (
    s.snapshot.workflow === "clinician" &&
    step &&
    "title" in visible &&
    "questions" in visible
  ) {
    if (step.kind === "diagnosis")
      visible.title = `Patient case ${s.step_index - s.snapshot.steps.findIndex((x: StudyStep) => x.kind === "diagnosis") + 1}`;
    visible.questions = step.questions.map((q) =>
      q.id === "physician" ? { ...q, label: ELIGIBILITY_CONFIRMATION } : q,
    );
  }
  if (
    s.snapshot.workflow === "clinician" &&
    step?.id === "instructions" &&
    "instructions" in visible
  )
    visible.instructions = CLINICIAN_INSTRUCTIONS;
  const result: SessionView = {
    id: s.id,
    status: s.status,
    step_index: s.step_index,
    total_steps: s.snapshot.steps.length,
    revision: s.revision,
    post_survey_version: s.snapshot.post_survey_version,
    step: step ? (visible as Omit<StudyStep, "case_id">) : null,
    workflow: s.snapshot.workflow || "agent",
    is_demo: !!s.snapshot.is_demo,
    total_cases: s.snapshot.steps.filter(
      (x: StudyStep) => x.kind === "diagnosis",
    ).length,
    completed_cases: s.snapshot.steps
      .slice(0, s.step_index)
      .filter((x: StudyStep) => x.kind === "diagnosis").length,
    include_in_analysis:
      s.include_in_analysis === null ? null : !!s.include_in_analysis,
  };
  if (s.status === "completed")
    result.completion_url = s.snapshot.completion_code
      ? `https://app.prolific.com/submissions/complete?cc=${s.snapshot.completion_code}`
      : null;
  return result;
}
export function studyInfo(c: StudyConfig): StudyInfo {
  return {
    id: c.id,
    title: c.title,
    version: c.version,
    consent_version: c.consent_version,
    consent_text: c.consent_text,
    workflow: c.workflow,
    is_demo: c.is_demo,
    cases_per_participant: c.cases_per_participant,
    pool_size: c.cases.length,
    sources: [...new Set(c.cases.map((x) => x.source))],
    source_counts: Object.fromEntries(
      [...new Set(c.cases.map((x) => x.source))].map((source) => [
        source,
        c.cases.filter((x) => x.source === source).length,
      ]),
    ),
    steps: c.steps.map(({ id, title, kind }) => ({ id, title, kind })),
  };
}
export async function event(
  db: Queryable,
  s: Row,
  step: string,
  type: string,
  data: Row = {},
) {
  await insert(db, "study_events", {
    id: randomUUID(),
    session_id: s.id,
    step_id: step,
    event_type: type,
    data,
    created_at: now(),
  });
}
export async function createSession(
  db: Queryable,
  config: StudyConfig,
  ids: {
    PROLIFIC_PID: string;
    STUDY_ID: string;
    SESSION_ID: string;
    eligibility_confirmed?: boolean;
    intro_timing?: { elapsed_ms: number; active_ms: number };
  },
  settings: Settings,
) {
  if (config.workflow === "clinician" && ids.eligibility_confirmed !== true)
    throw new HTTPException(422, {
      message: "Confirm that you are a physician or a doctor in training",
    });
  const { token, hash } = issueToken(settings.sessionSecret);
  const scope = allocationScope(config);
  let available = config.cases;
  if (scope) {
    // A shared database row serializes allocation across replicas and study versions.
    await db.query(
      "INSERT INTO allocation_locks(scope) VALUES($1) ON CONFLICT(scope) DO NOTHING",
      [scope],
    );
    await db.query("UPDATE allocation_locks SET scope=scope WHERE scope=$1", [
      scope,
    ]);
    const used = new Set(
      (
        await db.query("SELECT case_key FROM case_allocations WHERE scope=$1", [
          scope,
        ])
      ).rows.map((row) => row.case_key),
    );
    available = config.cases.filter((c) => !used.has(caseKey(config, c)));
  }
  const snapshot = assignCases(config, available);
  const s: Row = {
    id: randomUUID(),
    study_id: config.id,
    prolific_pid: ids.PROLIFIC_PID,
    prolific_study_id: ids.STUDY_ID,
    prolific_session_id: ids.SESSION_ID,
    token_hash: hash,
    model_id:
      config.workflow === "clinician"
        ? SUPPORT_MODEL
        : config.models[randomInt(config.models.length)],
    condition: config.conditions[randomInt(config.conditions.length)],
    snapshot,
    step_index: 0,
    revision: 0,
    status: "active",
    include_in_analysis: config.is_demo ? false : null,
    created_at: now(),
    completed_at: null,
  };
  await insert(db, "sessions", s);
  if (scope)
    for (const c of snapshot.cases)
      await insert(db, "case_allocations", {
        scope,
        case_key: caseKey(config, c),
        session_id: s.id,
        case_id: c.id,
        created_at: now(),
      });
  if (ids.intro_timing)
    await insert(db, "study_timings", {
      id: randomUUID(),
      session_id: s.id,
      step_id: "intro",
      phase: "page",
      round_number: 0,
      ...ids.intro_timing,
      created_at: now(),
      updated_at: now(),
    });
  for (const step of snapshot.steps)
    if (step.kind === "diagnosis")
      await insert(db, "clinical_cases", {
        id: randomUUID(),
        session_id: s.id,
        step_id: step.id,
        case_id: step.case_id,
        rounds_used: 0,
        diagnosis: null,
        confidence: null,
        confidence_scale: CONFIDENCE_SCALE,
        diagnosis_request_id: null,
        started_at: null,
        completed_at: null,
      });
  await event(db, s, "intro", "enrolled", {
    consent_version: config.consent_version,
    study_version: config.version,
    workflow: config.workflow,
    ...(config.workflow === "clinician"
      ? {
          eligibility_confirmed: true,
          research_and_anonymized_publication_consent: true,
          participant_information_version: PARTICIPANT_INFO_VERSION,
        }
      : {}),
  });
  return { ...sessionView(s), session_token: token };
}
export async function reserveRevision(db: Queryable, s: Row, revision: number) {
  const result = await db.query(
    "UPDATE sessions SET revision=revision+1 WHERE id=$1 AND revision=$2 AND status=$3",
    [s.id, revision, "active"],
  );
  if (result.rowCount !== 1)
    throw new HTTPException(409, {
      message: "Session changed; reload before submitting",
    });
  s.revision = revision + 1;
}
export function validateAnswers(step: StudyStep, answers: Row) {
  if (Object.keys(answers).some((k) => !step.questions.some((q) => q.id === k)))
    throw new HTTPException(422, { message: "Unknown question" });
  for (const q of step.questions) {
    const v = answers[q.id];
    if (!questionVisible(q, answers)) {
      if (v !== undefined)
        throw new HTTPException(422, {
          message: `Question does not apply: ${q.id}`,
        });
      continue;
    }
    if (v === undefined || v === null || v === "") {
      if (q.required)
        throw new HTTPException(422, { message: `Answer required: ${q.id}` });
      continue;
    }
    const valid =
      q.kind === "boolean"
        ? typeof v === "boolean"
        : q.kind === "likert"
          ? typeof v === "number" &&
            Number.isInteger(v) &&
            v >= (q.minimum ?? 1) &&
            v <= (q.maximum ?? 7)
          : q.kind === "number"
            ? typeof v === "number" &&
              Number.isFinite(v) &&
              (!q.integer || Number.isInteger(v)) &&
              (q.minimum === null || v >= q.minimum) &&
              (q.maximum === null || v <= q.maximum)
            : q.kind === "choice"
              ? q.options.includes(v)
              : q.kind === "multiple_choice"
                ? Array.isArray(v) &&
                  (!q.required || v.length > 0) &&
                  v.length <= q.options.length &&
                  new Set(v).size === v.length &&
                  v.every(
                    (option) =>
                      typeof option === "string" && q.options.includes(option),
                  )
                : typeof v === "string" && v.length <= 6000;
    if (!valid)
      throw new HTTPException(422, { message: `Invalid answer: ${q.id}` });
  }
}
export async function getAttempt(
  db: Queryable,
  s: Row,
  stepId: string,
  current = true,
) {
  const a = await one(
    db,
    "SELECT * FROM clinical_cases WHERE session_id=$1 AND step_id=$2",
    [s.id, stepId],
  );
  if (!a) throw new HTTPException(404, { message: "Case not found" });
  if (current && (s.status !== "active" || currentStep(s)?.id !== stepId))
    throw new HTTPException(409, { message: "This is not the current case" });
  return a;
}
