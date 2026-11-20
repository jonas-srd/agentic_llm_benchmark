import { createHash, createHmac } from "node:crypto";
import {
  FactPackSchema,
  type CaseSpec,
  type PatientFact,
} from "@clinical/shared";

export const FACT_PACK_VERSION = "source-facts-v1";
const sentences = new Intl.Segmenter("en", { granularity: "sentence" });

// Preserve source wording, section labels, negations, numbers and units. No LLM
// extraction and no access to reference_diagnosis or accepted_alternatives.
export function patientRecord(c: CaseSpec) {
  const facts: PatientFact[] = [];
  const imageIds = new Map<string, string[]>();
  function add(section: string, text: string) {
    for (const line of text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)) {
      const label = line.match(/^([^:.]{1,80}:)\s*/)?.[0] || "";
      for (const item of sentences.segment(line.slice(label.length))) {
        const value = item.segment.trim();
        if (!value) continue;
        const text = `${section}: ${label}${value}`;
        if (facts.some((fact) => fact.text === text)) continue;
        facts.push({
          id: `fact_${String(facts.length + 1).padStart(4, "0")}`,
          status: "recorded",
          text,
        });
      }
    }
  }
  if (c.fact_pack) facts.push(...FactPackSchema.parse(c.fact_pack));
  else {
    add("Initial presentation", c.opening);
    add("History", c.patient_facts);
    for (const [test, text] of Object.entries(c.labs)) add(test, text);
  }
  // Separate image facts prevent an examination answer from also revealing an image.
  for (const [index, test] of [
    ...new Set((c.media || []).map((m) => m.test)),
  ].entries()) {
    let id = `image_${index + 1}`;
    while (facts.some((fact) => fact.id === id)) id = `_${id}`;
    facts.push({
      id,
      status: "recorded",
      text: `${test}: An original image is available. Select this fact only if the doctor explicitly requests this image; do not describe unseen image content.`,
    });
    imageIds.set(
      id,
      c.media.filter((m) => m.test === test).map((m) => m.asset_id),
    );
  }
  FactPackSchema.parse(facts);
  return {
    facts,
    imageIds,
    sha256: createHash("sha256").update(JSON.stringify(facts)).digest("hex"),
  };
}

export type PatientRecord = ReturnType<typeof patientRecord>;

// Filter the finished record, including generated image facts, without renaming IDs.
// This also removes image permissions; the original case object is never mutated.
export function selectPatientFacts(
  record: PatientRecord,
  retainedIds: readonly string[],
): PatientRecord {
  const retained = new Set(retainedIds);
  if (
    retained.size !== retainedIds.length ||
    retainedIds.some((id) => !record.facts.some((fact) => fact.id === id))
  )
    throw new Error("invalid_retained_fact_ids");
  const facts = record.facts.filter((fact) => retained.has(fact.id));
  return {
    facts,
    imageIds: new Map([...record.imageIds].filter(([id]) => retained.has(id))),
    sha256: createHash("sha256").update(JSON.stringify(facts)).digest("hex"),
  };
}

export function planFactAblation(
  record: PatientRecord,
  caseId: string,
  seed: string,
  percent: 25 | 50,
) {
  if (!/^[0-9a-f]{64}$/.test(seed) || ![25, 50].includes(percent))
    throw new Error("invalid_ablation_settings");
  const protectedIds = record.facts
    .filter((fact) => fact.text.startsWith("Initial presentation:"))
    .map((fact) => fact.id);
  if (!protectedIds.length) throw new Error("opening_facts_not_identified");
  const protectedSet = new Set(protectedIds);
  const ranked = record.facts
    .filter((fact) => !protectedSet.has(fact.id))
    .map((fact) => ({
      id: fact.id,
      rank: createHmac("sha256", Buffer.from(seed, "hex"))
        .update(JSON.stringify(["fact-ablation-v1", caseId, fact.id]))
        .digest("hex"),
    }))
    .sort((a, b) =>
      a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1,
    );
  const removedCount = Math.floor((ranked.length * percent) / 100 + 0.5);
  const removedIds = ranked.slice(0, removedCount).map((fact) => fact.id);
  const removed = new Set(removedIds);
  const retainedIds = record.facts
    .filter((fact) => !removed.has(fact.id))
    .map((fact) => fact.id);
  return {
    percent,
    protectedIds,
    eligibleCount: ranked.length,
    removedIds,
    retainedIds,
    actualRemovedFraction: ranked.length ? removedCount / ranked.length : 0,
    originalSha256: record.sha256,
    effectiveSha256: selectPatientFacts(record, retainedIds).sha256,
  };
}
