import { z } from "zod";
export const MODEL_IDS = [
  "openai/gpt-6.1-sol",
  "anthropic/claude-sonnet-5.5",
  "qwen/qwen3.8-2.4t-a95b",
] as const;
export const Identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const ProlificId = z.string().regex(/^[a-zA-Z0-9]{24}$/);
export const RequestId = z.string().uuid();
export const MediaSchema = z.strictObject({
  asset_id: z.string().regex(/^[a-f0-9]{64}$/),
  test: z.string().min(1).max(100),
  caption: z.string().min(1).max(200),
});
export const QuestionSchema = z
  .strictObject({
    id: Identifier,
    label: z.string().min(1).max(1000),
    kind: z.enum(["text", "number", "boolean", "choice"]).default("text"),
    required: z.boolean().default(true),
    options: z.array(z.string().max(300)).max(30).default([]),
    minimum: z.number().nullable().default(null),
    maximum: z.number().nullable().default(null),
  })
  .refine(
    (q) => q.kind !== "choice" || q.options.length > 0,
    "Choice questions require options",
  )
  .refine(
    (q) => q.minimum === null || q.maximum === null || q.minimum <= q.maximum,
    "Invalid numeric bounds",
  );
export const StepSchema = z
  .strictObject({
    id: Identifier,
    title: z.string().min(1).max(200),
    kind: z.enum([
      "information",
      "questionnaire",
      "simulation",
      "diagnosis",
      "final_check",
    ]),
    instructions: z.string().max(10000).default(""),
    questions: z.array(QuestionSchema).max(50).default([]),
    case_id: Identifier.nullable().default(null),
  })
  .refine(
    (s) => new Set(s.questions.map((q) => q.id)).size === s.questions.length,
    "Duplicate questions",
  )
  .refine(
    (s) => !["simulation", "diagnosis"].includes(s.kind) || !!s.case_id,
    "Case required",
  );
export const CaseSchema = z
  .strictObject({
    id: Identifier,
    title: z.string().min(1).max(200),
    opening: z.string().min(1).max(3000),
    patient_facts: z.string().min(1).max(12000),
    labs: z.record(z.string().max(100), z.string().max(12000)).default({}),
    media: z.array(MediaSchema).max(20).default([]),
    reference_diagnosis: z.string().min(1).max(1000),
    source: z
      .enum(["MedQA", "NEJM", "MediQ", "Synthetic"])
      .default("Synthetic"),
    source_id: z.string().max(300).default(""),
  })
  .refine((c) => Object.keys(c.labs).length <= 50, "Too many tests")
  .refine(
    (c) => c.media.every((m) => Object.hasOwn(c.labs, m.test)),
    "Image requires an available test",
  )
  .refine(
    (c) => new Set(c.media.map((m) => m.asset_id)).size === c.media.length,
    "Duplicate images",
  );
export const StudySchema = z
  .strictObject({
    id: Identifier,
    title: z.string().min(1).max(200),
    version: z.string().min(1).max(40).default("1"),
    consent_version: z.string().min(1).max(40).default("1"),
    consent_text: z.string().min(1).max(20000),
    prolific_study_id: ProlificId.nullable().default(null),
    completion_code: z
      .string()
      .regex(/^[a-zA-Z0-9]{4,30}$/)
      .nullable()
      .default(null),
    max_participants: z.number().int().min(1).max(10000).default(100),
    max_doctor_turns: z.number().int().min(2).max(12).default(6),
    workflow: z.enum(["agent", "clinician"]).default("agent"),
    is_demo: z.boolean().default(false),
    cases_per_participant: z.number().int().min(1).max(150).default(5),
    max_question_rounds: z.literal(3).default(3),
    conditions: z.array(Identifier).min(1).max(10).default(["Human_Clinician"]),
    models: z
      .array(z.enum(MODEL_IDS))
      .min(1)
      .max(3)
      .default([...MODEL_IDS]),
    steps: z.array(StepSchema).min(1).max(200),
    cases: z.array(CaseSchema).min(1).max(150),
    pool_manifest: z
      .strictObject({
        repository: z.string().url(),
        commit: z.string().regex(/^[a-f0-9]{40}$/),
        seed: z.string().regex(/^[a-f0-9]{64}$/),
        selection: z.literal("50_per_dataset_v1"),
        adapter_version: z.string().min(1).max(100),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .nullable()
      .default(null),
  })
  .superRefine((c, ctx) => {
    const check = (ok: boolean, message: string) => {
      if (!ok) ctx.addIssue({ code: "custom", message });
    };
    for (const list of [c.steps, c.cases])
      check(
        new Set(list.map((x) => x.id)).size === list.length,
        "Duplicate IDs",
      );
    check(new Set(c.models).size === c.models.length, "Duplicate models");
    if (c.pool_manifest) {
      check(
        c.cases.length === 150 &&
          ["MedQA", "NEJM", "MediQ"].every(
            (source) =>
              c.cases.filter((x) => x.source === source).length === 50,
          ),
        "The study pool requires exactly 50 cases per dataset",
      );
      check(
        c.cases.every((x) => !!x.source_id),
        "Dataset cases require original IDs",
      );
      check(
        new Set(c.cases.map((x) => `${x.source}:${x.source_id}`)).size === 150,
        "Duplicate dataset cases",
      );
    }
    check(
      new Set(c.conditions).size === c.conditions.length,
      "Duplicate conditions",
    );
    check(
      c.steps.at(-1)?.kind === "final_check" &&
        !c.steps.slice(0, -1).some((s) => s.kind === "final_check"),
      "Final check must be last",
    );
    check(
      !c.steps.some(
        (s) => s.case_id && !c.cases.some((x) => x.id === s.case_id),
      ),
      "Unknown case",
    );
    if (c.workflow === "clinician") {
      check(c.cases_per_participant <= c.cases.length, "Subset exceeds pool");
      check(
        !c.steps.some(
          (s) =>
            ["simulation", "diagnosis"].includes(s.kind) ||
            s.id.startsWith("clinical-"),
        ),
        "Clinician case steps are generated",
      );
    }
  });
export const EnrollSchema = z.strictObject({
  PROLIFIC_PID: ProlificId,
  STUDY_ID: ProlificId,
  SESSION_ID: ProlificId,
  consent: z.literal(true),
  consent_version: z.string().min(1).max(40),
});
export const AnswerSchema = z
  .strictObject({
    request_id: RequestId,
    revision: z.number().int().nonnegative(),
    answers: z.record(z.string().max(64), z.unknown()).default({}),
    include_in_analysis: z.boolean().nullable().default(null),
  })
  .refine((v) => Object.keys(v.answers).length <= 50, "Too many answers");
export const ClinicalQuestionSchema = z
  .strictObject({
    request_id: RequestId,
    revision: z.number().int().nonnegative(),
    target: z.enum(["patient", "lab"]),
    question: z.string().trim().max(2000).default(""),
    tests: z.array(z.string().max(100)).max(10).default([]),
  })
  .refine(
    (v) =>
      v.target === "patient"
        ? !!v.question && !v.tests.length
        : !!v.tests.length && !v.question,
    "Provide a patient question or selected tests",
  )
  .refine((v) => new Set(v.tests).size === v.tests.length, "Duplicate tests");
export const DiagnosisSchema = z.strictObject({
  request_id: RequestId,
  revision: z.number().int().nonnegative(),
  diagnosis: z.string().trim().min(1).max(2000),
  confidence: z.number().int().min(0).max(100),
});
export const DraftSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  question: z.string().max(2000).default(""),
  tests: z.array(z.string().max(100)).max(10).default([]),
  diagnosis: z.string().max(2000).default(""),
  confidence: z.number().int().min(0).max(100).default(50),
});
export const EventsSchema = z.strictObject({
  events: z
    .array(
      z.strictObject({
        id: RequestId,
        step_id: Identifier,
        type: z.enum([
          "case_enter",
          "case_leave",
          "page_hidden",
          "page_visible",
        ]),
        client_ts: z.number().finite().nonnegative(),
      }),
    )
    .max(25),
});
export const DoctorActionSchema = z
  .strictObject({
    action: z.enum(["ask_patient", "order_lab", "diagnosis"]),
    message: z.string().min(1).max(6000),
    tests: z.array(z.string().max(100)).max(10).default([]),
    diagnosis: z.string().max(2000).nullable().default(null),
    confidence: z.number().min(0).max(1).nullable().default(null),
  })
  .refine(
    (v) => v.action !== "diagnosis" || (!!v.diagnosis && v.confidence !== null),
    "Diagnosis and confidence required",
  )
  .refine(
    (v) => v.action !== "order_lab" || !!v.tests.length,
    "Tests required",
  );
export type StudyConfig = z.infer<typeof StudySchema>;
export type StudyStep = z.infer<typeof StepSchema>;
export type CaseSpec = z.infer<typeof CaseSchema>;
export type Draft = z.infer<typeof DraftSchema>;
