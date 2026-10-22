import { createHash, createHmac } from "node:crypto";
import { CaseSchema } from "@clinical/shared";
export const SOURCE_COMMIT = "b30b35ce56bd0fae3f0d3818e7064025a497532a";
export const REPOSITORY =
  "https://github.com/AI-in-Management/multiagent-medical-diagnosis-system";
export const ADAPTER_VERSION = "medclarify-clinician-v1";
export const sourceFiles = {
  MedQA: "medqa.jsonl",
  NEJM: "structural_nejm.jsonl",
  MediQ: "structural_mediq.jsonl",
};
export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");
const diagnosis =
  /(?:Which of the following is|What is) (?:the |this |patient[’']s )?(?:most likely )?diagnosis/i;
const missingFigure =
  /\b(?:images?|photographs?|photomicrographs?|figures?)\b|\b(?:is|are) shown\b/i;
export function exclusionReason(source, row) {
  if (source === "NEJM") return null;
  if (!diagnosis.test(source === "MedQA" ? row.objective : row.question))
    return "not_a_direct_diagnosis_question";
  if (
    missingFigure.test(
      source === "MedQA" ? row.question : JSON.stringify(row.Patient_Case),
    )
  )
    return "references_unprovided_figure";
  return null;
}
export function samplePool(datasets, seed) {
  if (!/^[a-f0-9]{64}$/.test(seed))
    throw new Error("Use a 32-byte hexadecimal seed");
  return Object.fromEntries(
    Object.keys(sourceFiles).map((source) => {
      const rows = datasets[source].filter(
        (row) => !exclusionReason(source, row),
      );
      if (rows.length < 50)
        throw new Error(
          `${source}: need 50 eligible cases, found ${rows.length}`,
        );
      if (new Set(rows.map((r) => String(r.id))).size !== rows.length)
        throw new Error(`${source}: duplicate source IDs`);
      const selected = rows
        .map((row) => ({
          row,
          key: createHmac("sha256", seed)
            .update(`${source}:${row.id}`)
            .digest("hex"),
        }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .slice(0, 50)
        .map((x) => x.row);
      return [source, selected];
    }),
  );
}
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => i + a);
// Source fact indices checked against the pinned MedQA source. Unlisted facts
// remain history. A different selection requires review, never a guessed split.
export const medqaPartitions = {
  0: { exam: [5] },
  1: { exam: [6, 7], lab: [4] },
  6: { exam: range(5, 10), lab: [11] },
  7: { exam: [3, 7], lab: [5], imaging: [2], course: [4] },
  11: { exam: range(1, 9), lab: [10], imaging: [11] },
  12: { exam: [3, 4], imaging: [5] },
  15: { exam: [4, 5, 6], lab: [7, 8] },
  17: { exam: range(5, 11) },
  22: { exam: [9, 10, 11] },
  29: { lab: [3] },
  31: { exam: [2, 3], imaging: [4] },
  32: { lab: [1] },
  35: { exam: [1, 2, 3, 4], imaging: [5] },
  41: { exam: [4, 5] },
  43: { exam: range(8, 13), lab: [14] },
  44: { exam: [2, 3], lab: [4] },
  45: { exam: [4, 5], lab: [6] },
  46: { exam: [7, 8] },
  49: { exam: [4, 5, 6] },
  51: { exam: range(6, 13), lab: [14], imaging: [15] },
  58: { exam: [7, 8], imaging: [9], lab: [10] },
  67: { exam: range(10, 16) },
  72: { exam: range(2, 8) },
  74: { exam: [4, 5] },
  77: { exam: range(5, 10) },
  81: { exam: [6, 7, 8], imaging: [9] },
  94: { exam: [4, 5], imaging: [6] },
  98: { exam: [4, 5] },
  99: { exam: [5, 6], lab: [7] },
  108: { exam: [7, 8], imaging: [9] },
  123: { exam: [3], imaging: [4] },
  125: { exam: [2], lab: [4, 5], course: [3] },
  139: { exam: [3], lab: [4], course: [5] },
  141: { exam: [3, 4, 5, 6], imaging: [7], lab: [8] },
  142: { exam: [4, 5, 6, 7] },
  143: { exam: [3], lab: [4] },
  144: { exam: [7] },
  145: { lab: [1] },
  147: { exam: [3], lab: [4], imaging: [5, 6] },
  148: { exam: [9, 10] },
  149: { exam: [3, 4, 5], imaging: [6] },
  151: { exam: [1], lab: [2] },
  152: { exam: [3, 4] },
  154: { exam: [4, 5], lab: [6] },
  160: { exam: range(7, 12) },
  164: { exam: [2, 3] },
  165: { exam: [5, 6, 7] },
  166: { exam: [6, 7, 8, 9], imaging: [10] },
  168: { exam: [8, 9] },
  169: { exam: [2, 3], imaging: [4], lab: [5] },
};
const labels = {
  exam: "Physical examination",
  lab: "Laboratory and functional tests",
  imaging: "Imaging and ECG reports",
  course: "Clinical course and procedures",
};
export function textOf(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("\n");
  if (typeof value === "object")
    return Object.entries(value)
      .map(([k, v]) =>
        textOf(v) ? `${k.replaceAll("_", " ")}: ${textOf(v)}` : "",
      )
      .filter(Boolean)
      .join("\n");
  return String(value).trim();
}
export function adaptCase(source, row) {
  const labs = {};
  let opening, patient;
  if (source === "MedQA") {
    const split = medqaPartitions[row.id];
    if (!split)
      throw new Error(
        `Review the patient/lab partition for MedQA ${row.id} before creating a new pool`,
      );
    const assigned = Object.values(split).flat();
    if (
      new Set(assigned).size !== assigned.length ||
      assigned.some((i) => !row.facts[i])
    )
      throw new Error("Invalid MedQA fact partition");
    opening = row.facts[0];
    patient = row.facts.filter((_, i) => !assigned.includes(i)).join("\n");
    for (const [key, indices] of Object.entries(split))
      labs[labels[key]] = indices.map((i) => row.facts[i]).join("\n");
    // In this source, some laboratory tables are in 'objective', not 'facts'.
    const extra = row.objective
      .replace(/(?:Which of the following is|What is)[\s\S]*$/i, "")
      .trim();
    if (extra && !/^According to these results,?$/i.test(extra))
      labs[labels.lab] = [labs[labels.lab], extra].filter(Boolean).join("\n");
  } else {
    const p = row.Patient_Case,
      history = structuredClone(p.Patient_Factor);
    opening = [
      textOf(history.Demographics),
      textOf(history.Symptoms?.Primary_Symptom),
    ]
      .filter(Boolean)
      .join(". ");
    const procedures =
      /\b(?:performed|biopsy|histopathology|excised|removed|surgery|resected|revealed|showed|echocardiogram|computed tomography)\b/i;
    const facts = Array.isArray(history.History)
      ? history.History
      : [textOf(history.History)];
    history.History = facts.filter((s) => !procedures.test(s));
    const moved = facts.filter((s) => procedures.test(s));
    patient = textOf(history);
    const groups = {
      "Physical examination": p.Physical_Examination,
      "Laboratory results": p.Test_Results?.Laboratory,
      "Imaging reports": p.Test_Results?.Imaging,
      "Clinical course and procedures": moved,
    };
    for (const [label, value] of Object.entries(groups))
      if (textOf(value)) labs[label] = textOf(value);
    if (source === "MediQ") {
      const prefix = row.question
        .replace(/(?:Which of the following is|What is)[\s\S]*$/i, "")
        .trim();
      if (prefix) labs["Additional source test results"] = prefix;
    }
    if (source === "NEJM" && row.Image_URL)
      labs["Original case images"] =
        "Original case figure(s) supplied with this case. The full figure may contain several panels.";
  }
  return CaseSchema.parse({
    id: `${source.toLowerCase()}-${row.id}`,
    title: "Patient presentation",
    opening,
    patient_facts: patient,
    labs,
    reference_diagnosis: row.Correct_Answer || row.answer,
    source,
    source_id: String(row.id),
  });
}
