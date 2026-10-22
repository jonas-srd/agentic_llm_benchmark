import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error Offline preparation uses native Node ESM.
import {
  samplePool,
  adaptCase,
  exclusionReason,
} from "../../../scripts/medical-pool.mjs";
import { StudySchema } from "@clinical/shared";
import { demoConfig } from "../src/routes/studies.js";
test("pool selection has 50 unique cases per source and survives input reordering", () => {
  const datasets = Object.fromEntries(
    ["MedQA", "NEJM", "MediQ"].map((source) => [
      source,
      Array.from({ length: 70 }, (_, id) => ({
        id,
        objective: "What is the most likely diagnosis?",
        question: "What is the most likely diagnosis?",
        Patient_Case: {},
      })),
    ]),
  );
  const first = samplePool(datasets, "a".repeat(64));
  const reordered = Object.fromEntries(
    Object.entries(datasets).map(([s, rows]) => [s, rows.toReversed()]),
  );
  assert.deepEqual(first, samplePool(reordered, "a".repeat(64)));
  for (const rows of Object.values(first) as any[]) {
    assert.equal(rows.length, 50);
    assert.equal(new Set(rows.map((r: any) => r.id)).size, 50);
  }
  assert.notDeepEqual(first, samplePool(datasets, "b".repeat(64)));
  assert.throws(
    () =>
      samplePool(
        { ...datasets, NEJM: datasets.NEJM.slice(0, 49) },
        "a".repeat(64),
      ),
    /need 50/,
  );
  assert.ok(
    exclusionReason("MedQA", {
      objective: "How do you confirm the diagnosis?",
      question: "Choose a test",
    }),
  );
  assert.ok(
    exclusionReason("MedQA", {
      objective: "What is the most likely diagnosis?",
      question: "A photograph is shown.",
    }),
  );
});
test("adapters keep objective laboratory tables and isolate the reference diagnosis", () => {
  const row = {
    id: 12,
    facts: [
      "Presentation",
      "History one",
      "History two",
      "Vital signs",
      "Examination",
      "ECG report",
    ],
    objective:
      "Laboratory studies: Sodium 120 mmol/L. What is the most likely diagnosis?",
    answer: "SECRET ANSWER",
  };
  const c = adaptCase("MedQA", row);
  assert.equal(c.opening, "Presentation");
  assert.equal(c.patient_facts, "Presentation\nHistory one\nHistory two");
  assert.ok(c.labs["Laboratory and functional tests"].includes("120 mmol/L"));
  assert.ok(
    !JSON.stringify({
      opening: c.opening,
      patient: c.patient_facts,
      labs: c.labs,
    }).includes(row.answer),
  );
  assert.throws(() => adaptCase("MedQA", { ...row, id: 999 }), /Review/);
});
test("manifest studies reject unbalanced or duplicate-source pools", () => {
  const base = demoConfig();
  const config = {
    ...base,
    cases: Array.from({ length: 150 }, (_, i) => ({
      ...base.cases[0],
      id: `c-${i}`,
      source: ["MedQA", "NEJM", "MediQ"][i % 3],
      source_id: String(i),
    })),
    pool_manifest: {
      repository: "https://github.com/example/source",
      commit: "a".repeat(40),
      seed: "b".repeat(64),
      selection: "50_per_dataset_v1",
      adapter_version: "test",
      sha256: "c".repeat(64),
    },
  };
  assert.equal(StudySchema.safeParse(config).success, true);
  config.cases[0].source = "NEJM";
  assert.equal(StudySchema.safeParse(config).success, false);
  config.cases[0].source = "MedQA";
  config.cases[3].source_id = config.cases[0].source_id;
  assert.equal(StudySchema.safeParse(config).success, false);
});
