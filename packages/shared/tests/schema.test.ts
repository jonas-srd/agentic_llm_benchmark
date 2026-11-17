import test from "node:test";
import assert from "node:assert/strict";
import {
  StudySchema,
  ClinicalQuestionSchema,
  DiagnosisSchema,
  DraftSchema,
  TimingSchema,
  emptyDiagnoses,
  stagePath,
} from "../src/index.js";
import { randomUUID } from "node:crypto";
import { demoConfig } from "../../../apps/backend/src/routes/studies.js";
import { assignCases } from "../../../apps/backend/src/domain/study.js";
test("150-case pool yields a stable subset without duplicate cases", () => {
  const base = demoConfig();
  const config = StudySchema.parse({
    ...base,
    cases_per_participant: 5,
    cases: Array.from({ length: 150 }, (_, i) => ({
      ...base.cases[0],
      id: `case-${i}`,
      source: ["MedQA", "NEJM", "MediQ"][i % 3],
    })),
  });
  const snapshot = assignCases(config);
  assert.equal(snapshot.cases.length, 5);
  assert.equal(new Set(snapshot.cases.map((c) => c.id)).size, 5);
  assert.equal(new Set(snapshot.cases.map((c) => c.source)).size, 3);
  assert.equal(snapshot.steps.filter((s) => s.kind === "diagnosis").length, 5);
  assert.equal(config.cases.length, 150);
});
test("schema rejects oversized pools, unsupported models and manual clinician stages", () => {
  const base = demoConfig();
  assert.deepEqual(
    StudySchema.parse({ ...base, models: ["qwen/qwen3.8-2.4t-a95b"] }).models,
    ["qwen/qwen3.8-27b"],
  );
  assert.equal(
    StudySchema.safeParse({ ...base, cases_per_participant: 151 }).success,
    false,
  );
  assert.equal(
    StudySchema.safeParse({ ...base, models: ["unknown"] }).success,
    false,
  );
  assert.equal(
    StudySchema.safeParse({
      ...base,
      steps: [
        {
          id: "clinical-1",
          title: "Case",
          kind: "diagnosis",
          case_id: base.cases[0].id,
        },
        base.steps.at(-1),
      ],
    }).success,
    false,
  );
});
test("completed sessions always route to the final receipt", () => {
  assert.equal(stagePath({ status: "completed" } as any), "/study/outro");
});
test("the chat accepts patient questions and rejects lab targets and test selections", () => {
  const body = {
    request_id: randomUUID(),
    revision: 0,
    question: "What do the blood tests show?",
  };
  assert.equal(ClinicalQuestionSchema.parse(body).target, "patient");
  assert.equal(
    ClinicalQuestionSchema.parse({ ...body, target: "auto" }).target,
    "patient",
  );
  for (const invalid of [
    { target: "lab" },
    { target: "both" },
    { tests: ["CBC"] },
    { question: "   " },
  ])
    assert.equal(
      ClinicalQuestionSchema.safeParse({ ...body, ...invalid }).success,
      false,
    );
});
test("exactly one diagnosis requires a 1–7 confidence, with midpoint draft default", () => {
  const body = { request_id: randomUUID(), revision: 0 };
  for (const confidence of [1, 4, 7])
    assert.ok(
      DiagnosisSchema.safeParse({
        ...body,
        diagnoses: [{ diagnosis: "A", confidence }],
      }).success,
    );
  for (const diagnoses of [
    [],
    emptyDiagnoses(),
    [{ diagnosis: "", confidence: null }],
    [{ diagnosis: "A", confidence: 0 }],
    [{ diagnosis: "A", confidence: 8 }],
    [{ diagnosis: "A", confidence: null }],
    [{ diagnosis: "A", confidence: 4.5 }],
    [{ diagnosis: "A", probability: 100 }],
    [
      { diagnosis: "A", confidence: 4 },
      { diagnosis: "B", confidence: 3 },
    ],
    [
      { diagnosis: "A", confidence: 4 },
      { diagnosis: "", confidence: null },
      { diagnosis: "", confidence: null },
    ],
  ])
    assert.equal(
      DiagnosisSchema.safeParse({ ...body, diagnoses }).success,
      false,
    );
  assert.ok(
    DraftSchema.safeParse({ revision: 0, diagnoses: emptyDiagnoses() }).success,
  );
  assert.equal(
    DraftSchema.safeParse({
      revision: 0,
      diagnoses: [...emptyDiagnoses(), ...emptyDiagnoses()],
    }).success,
    false,
  );
  assert.deepEqual(emptyDiagnoses(), [{ diagnosis: "", confidence: 4 }]);
});

test("three rounds are enforced while historical timing remains accepted", () => {
  assert.equal(
    StudySchema.parse({ ...demoConfig(), max_question_rounds: 5 })
      .max_question_rounds,
    3,
  );
  const body = {
    id: randomUUID(),
    step_id: "clinical-1",
    phase: "round",
    round_number: 5,
    duration: { elapsed_ms: 500, active_ms: 400 },
  };
  assert.ok(TimingSchema.safeParse(body).success);
  assert.equal(
    TimingSchema.safeParse({ ...body, round_number: 6 }).success,
    false,
  );
});
