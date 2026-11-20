import test from "node:test";
import assert from "node:assert/strict";
import { CaseSchema } from "@clinical/shared";
import {
  patientRecord,
  selectPatientFacts,
  planFactAblation,
} from "../src/domain/facts.js";
import { answerPatient } from "../src/domain/patient.js";
import { runSimulation } from "../src/domain/agents.js";
import type { Provider, Message } from "../src/lib/openrouter.js";

const sample = CaseSchema.parse({
  id: "ablation-test",
  title: "Case",
  opening: "A patient reports a cough.",
  patient_facts: "REMOVED_HISTORY. Retained history.",
  labs: {
    blood: "REMOVED_TEST: 42 units.",
    "scan one": "REMOVED_SCAN: First result.",
    "scan two": "Retained scan result.",
  },
  reference_diagnosis: "PRIVATE_REFERENCE",
  accepted_alternatives: ["PRIVATE_ALTERNATIVE"],
  media: [
    { asset_id: "a".repeat(64), test: "scan one", caption: "First scan" },
    { asset_id: "b".repeat(64), test: "scan two", caption: "Second scan" },
  ],
});
const seed = "ab".repeat(32);
const stub = (
  fn: (messages: Message[], model: string) => string,
): Provider => ({
  complete: async (model, messages) => ({
    content: fn(messages, model),
    requested_model: model,
    returned_model: model,
    provider: "test",
    generation_id: "test",
    usage: {},
    latency_ms: 0,
  }),
});

test("ablation is deterministic, nested, protects opening facts and rounds the eligible count", () => {
  const original = patientRecord(sample);
  const before = JSON.stringify(sample);
  const p25 = planFactAblation(original, sample.id, seed, 25);
  const p50 = planFactAblation(original, sample.id, seed, 50);
  assert.deepEqual(planFactAblation(original, sample.id, seed, 25), p25);
  assert(p25.removedIds.every((id) => p50.removedIds.includes(id)));
  assert(
    p50.protectedIds.every(
      (id) => p25.retainedIds.includes(id) && p50.retainedIds.includes(id),
    ),
  );
  assert.equal(
    p25.removedIds.length,
    Math.floor(p25.eligibleCount * 0.25 + 0.5),
  );
  assert.equal(
    p50.removedIds.length,
    Math.floor(p50.eligibleCount * 0.5 + 0.5),
  );
  assert.deepEqual(
    planFactAblation(
      { ...original, facts: [...original.facts].reverse() },
      sample.id,
      seed,
      25,
    ).removedIds,
    p25.removedIds,
  );
  assert.equal(JSON.stringify(sample), before);
  assert.equal(p25.originalSha256, original.sha256);
  assert.notEqual(p25.effectiveSha256, original.sha256);
  assert.throws(
    () => selectPatientFacts(original, ["unknown"]),
    /invalid_retained_fact_ids/,
  );
  assert.throws(
    () =>
      selectPatientFacts(original, [
        original.facts[0].id,
        original.facts[0].id,
      ]),
    /invalid_retained_fact_ids/,
  );
});

test("removed facts and image permissions disappear without renumbering surviving image IDs", async () => {
  const original = patientRecord(sample);
  const keep = original.facts
    .filter((f) => !f.text.includes("REMOVED_") && f.id !== "image_1")
    .map((f) => f.id);
  const reduced = selectPatientFacts(original, keep);
  assert(!reduced.imageIds.has("image_1"));
  assert.deepEqual(reduced.imageIds.get("image_2"), ["b".repeat(64)]);
  assert.deepEqual(
    reduced.facts.map((f) => f.id),
    keep,
  );
  for (const version of [
    "clinical-patient-fact-ids-v3",
    "clinical-patient-fact-ids-v4",
  ] as const) {
    const result = await answerPatient(
      stub((messages) => {
        assert(!messages[0].content.includes("REMOVED_"));
        assert(!messages[0].content.includes('"id":"image_1"'));
        assert(!messages[0].content.includes("PRIVATE_REFERENCE"));
        assert(messages[0].content.includes('"id":"image_2"'));
        return JSON.stringify({
          fact_ids: ["image_2"],
          answer: "Here is the second scan.",
        });
      }),
      sample,
      "May I see the second scan?",
      [],
      version,
      keep,
    );
    assert.equal(result.metadata.fact_pack_sha256, reduced.sha256);
    assert.deepEqual(result.metadata.released_image_ids, ["b".repeat(64)]);
    await assert.rejects(
      answerPatient(
        stub(() =>
          JSON.stringify({ fact_ids: ["image_1"], answer: "Here it is." }),
        ),
        sample,
        "May I see the first scan?",
        [],
        version,
        keep,
      ),
      /patient_fact_id_not_in_record/,
    );
    const restored = await answerPatient(
      stub((messages) => {
        assert.deepEqual(
          JSON.parse(messages[0].content.split("\n").at(-1)!),
          original.facts,
        );
        return JSON.stringify({
          fact_ids: ["image_1"],
          answer: "Here is the first scan.",
        });
      }),
      sample,
      "What does the first scan show?",
      [],
      version,
    );
    assert.equal(restored.metadata.fact_pack_sha256, original.sha256);
    assert.deepEqual(restored.metadata.released_image_ids, ["a".repeat(64)]);
  }
});

test("all three patient calls use the ablated record while doctor opening and final diagnosis protocol stay unchanged", async () => {
  const original = patientRecord(sample);
  const keep = original.facts
    .filter((f) => !f.text.includes("REMOVED_") && !f.id.startsWith("image_"))
    .map((f) => f.id);
  let doctors = 0,
    patients = 0;
  const noImages = {
    query: async () => {
      throw new Error("A removed image must never be loaded");
    },
  };
  const result = await runSimulation(
    noImages,
    sample,
    "test-doctor",
    stub((messages, model) => {
      if (model === "test-doctor") {
        assert.equal(
          messages[1].content,
          JSON.stringify({ case: sample.opening }),
        );
        assert(!JSON.stringify(messages).includes("PRIVATE_REFERENCE"));
        return JSON.stringify(
          ++doctors <= 3
            ? { question: "What did the blood test show?" }
            : { diagnoses: [{ diagnosis: "Assessment", confidence: 4 }] },
        );
      }
      patients++;
      assert(!messages[0].content.includes("REMOVED_"));
      assert(!messages[0].content.includes("original image is available"));
      return JSON.stringify({ fact_ids: [], answer: "I'm not sure." });
    }),
    async () => {},
    async () => {},
    "clinical-patient-fact-ids-v4",
    keep,
  );
  assert.equal(doctors, 4);
  assert.equal(patients, 3);
  assert.equal(result.questions_used, 3);
  assert.equal(result.diagnoses[0].confidence, 4);
  assert.equal(sample.reference_diagnosis, "PRIVATE_REFERENCE");
});
