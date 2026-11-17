import {
  MODEL_IDS,
  CLINICAL_ROUNDS,
  CLINICAL_PROTOCOL,
  CLINICIAN_CONSENT_TEXT,
  PARTICIPANT_INFO_VERSION,
  ELIGIBILITY_CONFIRMATION,
  isPostSurvey,
  POST_SURVEY_VERSION,
  POST_SURVEY_STEPS,
  type StudyConfig,
  type CaseSpec,
} from "@clinical/shared";
export const SUPPORT_MODEL = MODEL_IDS[0];
export const CLINICIAN_INSTRUCTIONS =
  "Imagine a patient comes to your office. You are given some information about their symptoms, but not the full picture. Ask follow-up questions to identify the correct diagnosis. Ask three questions, one at a time. You can ask about their history or request examination findings, tests or images. After the third answer, enter the single most likely diagnosis. Rate your confidence from 1 (not at all confident) to 7 (extremely confident). After all patient cases, complete a short questionnaire. There is no time limit.";
export function clinicianProtocol(config: StudyConfig): StudyConfig {
  if (config.workflow !== "clinician") return config;
  const steps = config.steps.filter(
    (step) =>
      !isPostSurvey(step.id) &&
      !(
        step.id === "screening" &&
        step.questions.every((q) =>
          ["physician", "specialty", "years"].includes(q.id),
        )
      ),
  );
  return {
    ...config,
    models: [SUPPORT_MODEL],
    max_question_rounds: CLINICAL_ROUNDS,
    clinical_protocol_version: CLINICAL_PROTOCOL,
    post_survey_version: POST_SURVEY_VERSION,
    consent_version: PARTICIPANT_INFO_VERSION,
    consent_text: CLINICIAN_CONSENT_TEXT,
    steps: [...steps.slice(0, -1), ...POST_SURVEY_STEPS, steps.at(-1)!].map(
      (step) => ({
        ...step,
        ...(step.id === "instructions"
          ? { instructions: CLINICIAN_INSTRUCTIONS }
          : {}),
        questions: step.questions.map((q) =>
          q.id === "physician" ? { ...q, label: ELIGIBILITY_CONFIRMATION } : q,
        ),
      }),
    ),
  };
}
export function allocationScope(config: StudyConfig): string | null {
  if (
    config.workflow !== "clinician" ||
    (config.is_demo && !config.pool_manifest)
  )
    return null;
  return config.is_demo ? "medical-demo" : "medical-live";
}
export function caseKey(config: Pick<StudyConfig, "id">, c: CaseSpec): string {
  return JSON.stringify([c.source, c.source_id || `${config.id}:${c.id}`]);
}
