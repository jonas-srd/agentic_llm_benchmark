import { DOCTOR_PROMPT_V8 } from "./doctor-prompt-v8.js";

// Frozen for exact offline replay of the completed open-question experiment.
export const DOCTOR_PROMPT_V9 = {
  version: "doctor-patient-top1-three-rounds-open-ended-prompt10-truncate15-v9",
  systemPrompt: DOCTOR_PROMPT_V8.systemPrompt.replace(
    "You may ask about the history",
    "Ask only open-ended questions that invite a descriptive answer. Do not ask yes/no, forced-choice or leading questions. Phrase requests for examination findings, tests or images as open-ended questions as well. You may ask about the history",
  ),
  turnInstructions: [
    "Question 1 of 3: ask the patient one open-ended question as JSON now.",
    "Question 2 of 3: ask the patient one open-ended question as JSON now.",
    "Question 3 of 3: ask the patient one open-ended question as JSON now.",
    "The patient has answered all three questions. Return your single final diagnosis and confidence as JSON now.",
  ],
} as const;
