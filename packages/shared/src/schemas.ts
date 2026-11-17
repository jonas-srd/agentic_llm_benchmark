import { z } from "zod";
export const MODEL_IDS = [
  "openai/gpt-6.1-sol",
  "anthropic/claude-sonnet-5.5",
  "qwen/qwen3.8-27b",
] as const;
// Old study definitions and session snapshots can still contain the text-only model.
export const LEGACY_QWEN = "qwen/qwen3.8-2.4t-a95b";
export function currentInterviewerModel(
  id: (typeof MODEL_IDS)[number] | typeof LEGACY_QWEN,
) {
  return id === LEGACY_QWEN ? MODEL_IDS[2] : id;
}
export const Identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const ProlificId = z.string().regex(/^[a-zA-Z0-9]{24}$/);
export const RequestId = z.string().uuid();
export const CLINICAL_ROUNDS = 3;
export const CLINICAL_PROTOCOL = "patient-only-top1-three-rounds-v5";
export const CONFIDENCE_SCALE = "likert_1_7";
export const DEFAULT_CONFIDENCE = 4;
export const CONFIDENCE_LABELS = [
  "Not at all confident",
  "Slightly confident",
  "Somewhat confident",
  "Moderately confident",
  "Fairly confident",
  "Very confident",
  "Extremely confident",
] as const;
const DiagnosisConfidence = z.number().int().min(1).max(7);
export const DiagnosisItemSchema = z.strictObject({
  diagnosis: z.string().trim().max(2000),
  confidence: DiagnosisConfidence.nullable(),
});
export const DiagnosisListSchema = z.array(DiagnosisItemSchema).length(1);
export const RankedDiagnosesSchema = DiagnosisListSchema.superRefine(
  (items, ctx) => {
    if (!items[0]?.diagnosis)
      ctx.addIssue({
        code: "custom",
        message: "A diagnosis is required",
        path: [0, "diagnosis"],
      });
    items.forEach((item, i) => {
      if (item.diagnosis && item.confidence === null)
        ctx.addIssue({
          code: "custom",
          message: "Rate your confidence from 1 to 7",
          path: [i, "confidence"],
        });
      if (!item.diagnosis && item.confidence !== null)
        ctx.addIssue({
          code: "custom",
          message: "An empty diagnosis must have no confidence rating",
          path: [i, "confidence"],
        });
    });
  },
);
export type RankedDiagnosis = z.infer<typeof DiagnosisItemSchema>;
export const emptyDiagnoses = (): RankedDiagnosis[] =>
  Array.from({ length: 1 }, () => ({
    diagnosis: "",
    confidence: DEFAULT_CONFIDENCE,
  }));
// Normalize the submitted text; final validation still requires a diagnosis.
export const diagnosisSubmission = (
  items: RankedDiagnosis[],
): RankedDiagnosis[] =>
  items.map((item) => ({
    diagnosis: item.diagnosis.trim(),
    confidence: item.diagnosis.trim() ? item.confidence : null,
  }));
// Keep old draft wording without interpreting percentages as ordinal ratings.
export function confidenceDraft(
  items: unknown,
  count: 1 | 3 = 1,
): RankedDiagnosis[] {
  const list = Array.isArray(items) ? items : [];
  return Array.from({ length: count }, (_, index) => {
    const fallback = { diagnosis: "", confidence: DEFAULT_CONFIDENCE };
    const item = list[index];
    const parsed = DiagnosisItemSchema.safeParse(item);
    if (parsed.success)
      return {
        ...parsed.data,
        confidence: parsed.data.confidence ?? DEFAULT_CONFIDENCE,
      };
    return {
      ...fallback,
      diagnosis: typeof item?.diagnosis === "string" ? item.diagnosis : "",
    };
  });
}
export const MediaSchema = z.strictObject({
  asset_id: z.string().regex(/^[a-f0-9]{64}$/),
  test: z.string().min(1).max(100),
  caption: z.string().min(1).max(200),
});
export const PatientFactSchema = z.strictObject({
  id: Identifier,
  // "recorded" preserves legacy source wording without guessing symptom polarity.
  status: z.enum(["recorded", "present", "absent", "unknown"]),
  text: z.string().trim().min(1).max(12000),
});
export const FactPackSchema = z
  .array(PatientFactSchema)
  .min(1)
  .max(1000)
  .refine(
    (facts) => new Set(facts.map((fact) => fact.id)).size === facts.length,
    "Duplicate fact IDs",
  );
export type PatientFact = z.infer<typeof PatientFactSchema>;
export const QuestionSchema = z
  .strictObject({
    id: Identifier,
    label: z.string().min(1).max(1000),
    kind: z
      .enum([
        "text",
        "number",
        "boolean",
        "choice",
        "multiple_choice",
        "likert",
      ])
      .default("text"),
    required: z.boolean().default(true),
    options: z.array(z.string().max(300)).max(60).default([]),
    minimum: z.number().nullable().default(null),
    maximum: z.number().nullable().default(null),
    integer: z.boolean().default(false),
    section: z.string().max(100).optional(),
    lower_label: z.string().max(100).optional(),
    upper_label: z.string().max(100).optional(),
    visible_when: z
      .strictObject({
        question_id: Identifier,
        equals: z.union([z.boolean(), z.string()]),
      })
      .optional(),
  })
  .refine(
    (q) =>
      !["choice", "multiple_choice"].includes(q.kind) || q.options.length > 0,
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
    (s) =>
      s.questions.every(
        (q, i) =>
          !q.visible_when ||
          s.questions
            .slice(0, i)
            .some(
              (parent) =>
                parent.id === q.visible_when!.question_id &&
                !parent.visible_when &&
                ["boolean", "choice"].includes(parent.kind),
            ),
      ),
    "Conditional questions require an earlier unconditional boolean or choice question",
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
    accepted_alternatives: z
      .array(z.string().trim().min(1).max(1000))
      .max(30)
      .default([]),
    fact_pack: FactPackSchema.optional(),
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
    // Accept old import files; the current clinician protocol always uses three rounds.
    max_question_rounds: z
      .union([z.literal(3), z.literal(5)])
      .default(3)
      .transform(() => CLINICAL_ROUNDS),
    clinical_protocol_version: z
      .enum([
        "patient-only-top3-v2",
        "patient-only-top3-likert-v3",
        "patient-only-top1-likert-v4",
        CLINICAL_PROTOCOL,
      ])
      .optional(),
    post_survey_version: z.string().max(100).optional(),
    conditions: z.array(Identifier).min(1).max(10).default(["Human_Clinician"]),
    models: z
      .array(
        z.enum([...MODEL_IDS, LEGACY_QWEN]).transform(currentInterviewerModel),
      )
      .min(1)
      .max(3)
      .default([...MODEL_IDS]),
    steps: z.array(StepSchema).min(1).max(200),
    cases: z.array(CaseSchema).min(1).max(300),
    pool_manifest: z
      .strictObject({
        repository: z.string().url(),
        commit: z.string().regex(/^[a-f0-9]{40}$/),
        seed: z.string().regex(/^[a-f0-9]{64}$/),
        selection: z.enum(["50_per_dataset_v1", "100_per_dataset_v2"]),
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
      const perDataset =
        c.pool_manifest.selection === "100_per_dataset_v2" ? 100 : 50;
      check(
        c.cases.length === perDataset * 3 &&
          ["MedQA", "NEJM", "MediQ"].every(
            (source) =>
              c.cases.filter((x) => x.source === source).length === perDataset,
          ),
        `The study pool requires exactly ${perDataset} cases per dataset`,
      );
      check(
        c.cases.every((x) => !!x.source_id),
        "Dataset cases require original IDs",
      );
      check(
        new Set(c.cases.map((x) => `${x.source}:${x.source_id}`)).size ===
          c.cases.length,
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
export const DurationSchema = z
  .strictObject({
    elapsed_ms: z.number().int().min(0).max(259200000),
    active_ms: z.number().int().min(0).max(259200000),
  })
  .refine(
    (v) => v.active_ms <= v.elapsed_ms,
    "Active time exceeds elapsed time",
  );
export const TimingSchema = z.strictObject({
  id: RequestId,
  step_id: Identifier,
  phase: z.enum(["page", "round", "response", "diagnosis"]),
  // Accept late timing updates from historical five-round sessions.
  round_number: z.number().int().min(0).max(5),
  duration: DurationSchema,
});
export const EnrollSchema = z.strictObject({
  PROLIFIC_PID: ProlificId,
  STUDY_ID: ProlificId,
  SESSION_ID: ProlificId,
  consent: z.literal(true),
  eligibility_confirmed: z.literal(true).optional(),
  consent_version: z.string().min(1).max(40),
  intro_timing: DurationSchema.optional(),
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
    target: z
      .enum(["auto", "patient"])
      .default("patient")
      .transform(() => "patient" as const),
    question: z.string().trim().max(6000).default(""),
    tests: z.array(z.string().max(100)).max(0).default([]),
  })
  .refine((v) => !!v.question, "Provide a chat question")
  .refine((v) => new Set(v.tests).size === v.tests.length, "Duplicate tests");
export const DiagnosisSchema = z.strictObject({
  request_id: RequestId,
  revision: z.number().int().nonnegative(),
  diagnoses: RankedDiagnosesSchema,
});
export const DraftSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  question: z.string().max(6000).default(""),
  lab_question: z.string().max(2000).default(""),
  tests: z.array(z.string().max(100)).max(10).default([]),
  diagnosis: z.string().max(2000).default(""),
  confidence: z.number().int().min(0).max(100).default(50),
  diagnoses: DiagnosisListSchema.default(emptyDiagnoses),
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
export const DoctorDiagnosesSchema = z.strictObject({
  diagnoses: z
    .array(
      z.strictObject({
        diagnosis: z.string().trim().min(1).max(2000),
        confidence: DiagnosisConfidence,
      }),
    )
    .length(1),
});
export type StudyConfig = z.infer<typeof StudySchema>;
export type StudyStep = z.infer<typeof StepSchema>;
export type CaseSpec = z.infer<typeof CaseSchema>;
export type Draft = z.infer<typeof DraftSchema>;
