import { z } from "zod";
import {
  CLINICAL_ROUNDS,
  CONFIDENCE_SCALE,
  DoctorDiagnosesSchema,
  type CaseSpec,
} from "@clinical/shared";
import type { Message, Provider, Reply } from "../lib/openrouter.js";
import { answerPatient, PATIENT_CHAT_VERSION } from "./patient.js";
import { loadDoctorImages } from "./media.js";
import type { Queryable } from "../lib/db.js";
import { DOCTOR_PROMPT_V8 } from "./doctor-prompt-v8.js";
import { DOCTOR_PROMPT_V9 } from "./doctor-prompt-v9.js";

export const PROMPT_VERSION =
  "doctor-patient-top1-three-rounds-closed-ended-prompt10-truncate15-v10";
export const DOCTOR_PROMPT_QUESTION_WORDS = 10;
export const MAX_DOCTOR_QUESTION_WORDS = 15;
export const DOCTOR = DOCTOR_PROMPT_V8.systemPrompt.replace(
  "You may ask about the history",
  "Ask only closed-ended questions that can be answered with yes/no or a choice between explicitly stated alternatives. Do not ask for descriptions, explanations or narratives. Avoid leading questions. Phrase requests for examination findings, tests or images as closed-ended questions as well. You may ask about the history",
);
export const DOCTOR_TURN_INSTRUCTIONS = [
  "Question 1 of 3: ask the patient one closed-ended question as JSON now.",
  "Question 2 of 3: ask the patient one closed-ended question as JSON now.",
  "Question 3 of 3: ask the patient one closed-ended question as JSON now.",
  "The patient has answered all three questions. Return your single final diagnosis and confidence as JSON now.",
] as const;
export function getDoctorPrompt(version: string) {
  if (version === DOCTOR_PROMPT_V8.version) return DOCTOR_PROMPT_V8;
  if (version === DOCTOR_PROMPT_V9.version) return DOCTOR_PROMPT_V9;
  if (version === PROMPT_VERSION)
    return {
      version: PROMPT_VERSION,
      systemPrompt: DOCTOR,
      turnInstructions: DOCTOR_TURN_INSTRUCTIONS,
    } as const;
  throw new Error("unsupported_doctor_prompt_version");
}
const Question = z.strictObject({
  question: z.string().trim().min(1),
});
function parseDoctorReply(content: string): unknown {
  // Some providers wrap even JSON-mode completions. Keep the verbatim reply in the log.
  const fenced = /^```(?:json)?[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```$/i.exec(
    content.trim(),
  );
  return JSON.parse(fenced ? fenced[1] : content);
}
export function parseDoctorQuestion(content: string): string {
  const { question } = Question.parse(parseDoctorReply(content));
  const words = Array.from(question.matchAll(/\S+/gu));
  const lastWord = words[Math.min(words.length, MAX_DOCTOR_QUESTION_WORDS) - 1];
  return question.slice(0, lastWord.index + lastWord[0].length);
}
export async function runSimulation(
  db: Queryable,
  c: CaseSpec,
  model: string,
  provider: Provider,
  record: (role: string, reply: Reply, promptVersion: string) => Promise<void>,
  renew: () => Promise<void>,
  patientVersion:
    | typeof PATIENT_CHAT_VERSION
    | "clinical-patient-fact-ids-v3" = PATIENT_CHAT_VERSION,
  retainedFactIds?: readonly string[],
  doctorPromptVersion: string = PROMPT_VERSION,
) {
  const doctorPrompt = getDoctorPrompt(doctorPromptVersion);
  const transcript: Message[] = [
    { role: "user", content: JSON.stringify({ case: c.opening }) },
  ];
  const history: Array<{ question: string; answer: string }> = [];
  async function askDoctor(instruction: string) {
    await renew();
    const reply = await provider.complete(
      model,
      [
        { role: "system", content: doctorPrompt.systemPrompt },
        ...transcript,
        { role: "user", content: instruction },
      ],
      true,
    );
    await record("doctor", reply, doctorPrompt.version);
    return reply;
  }
  for (let round = 1; round <= CLINICAL_ROUNDS; round++) {
    const reply = await askDoctor(doctorPrompt.turnInstructions[round - 1]);
    const question = parseDoctorQuestion(reply.content);
    transcript.push({
      role: "assistant",
      content: JSON.stringify({ question }),
    });
    await renew();
    const patient = await answerPatient(
      provider,
      c,
      question,
      history,
      patientVersion,
      retainedFactIds,
    );
    const {
      prompt_version,
      requested_model,
      returned_model,
      provider: returnedProvider,
      generation_id,
      usage,
      latency_ms,
    } = patient.metadata;
    // The research transcript links the reply to its facts and original images.
    await record(
      "patient",
      {
        content: JSON.stringify({
          answer: patient.response,
          metadata: patient.metadata,
        }),
        requested_model,
        returned_model,
        provider: returnedProvider,
        generation_id,
        usage,
        latency_ms,
      },
      prompt_version,
    );
    history.push({ question, answer: patient.response });
    const images = await loadDoctorImages(
      db,
      c,
      patient.metadata.released_image_ids,
    );
    transcript.push({
      role: "user",
      content: patient.response,
      ...(images.length ? { images } : {}),
    });
  }
  const final = await askDoctor(doctorPrompt.turnInstructions[3]);
  return {
    ...DoctorDiagnosesSchema.parse(parseDoctorReply(final.content)),
    questions_used: history.length,
    confidence_scale: CONFIDENCE_SCALE,
    interviewer_model_id: model,
    protocol_version: doctorPrompt.version,
  } as const;
}
