import test from "node:test";
import assert from "node:assert/strict";
import { StudySchema, stagePath } from "../src/index.js";
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
  assert.equal(snapshot.steps.filter((s) => s.kind === "diagnosis").length, 5);
  assert.equal(config.cases.length, 150);
});
test("schema rejects oversized pools, unsupported models and manual clinician stages", () => {
  const base = demoConfig();
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
