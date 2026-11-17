import type { CaseSpec } from "@clinical/shared";
import type { Row } from "../lib/db.js";
import { usesPatientFactIds } from "./patient.js";
import { selectedCaseMedia } from "./media.js";

// New conversational turns release only model-selected, validated images.
// Older completed orders keep their existing access without rewriting history.
export function releasedMedia(c: CaseSpec, turn: Row) {
  const target = turn.metadata_json?.resolved_target || turn.target;
  const version = turn.metadata_json?.prompt_version;
  if (
    (!["lab", "both"].includes(target) &&
      !usesPatientFactIds(version) &&
      version !== "clinical-patient-all-findings-v2") ||
    turn.status !== "succeeded"
  )
    return [];
  if (turn.question?.trim()) {
    const ids = turn.metadata_json?.released_image_ids;
    return Array.isArray(ids) ? selectedCaseMedia(c, ids) : [];
  }
  return (c.media || []).filter((m) => turn.tests.includes(m.test));
}
