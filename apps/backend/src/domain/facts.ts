import { createHash } from "node:crypto";
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
