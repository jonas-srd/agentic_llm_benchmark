export const PARTICIPANT_INFO_VERSION = "participant-info-2026-11-03";
export const PARTICIPANT_INFORMATION =
  "Participation is voluntary. Your questions, diagnoses and other responses, together with the time spent on each page and round, will be recorded. Do not include information about your own patients.";
export const NO_TIME_LIMIT = "There is no time limit.";
export const ELIGIBILITY_CONFIRMATION =
  "I confirm that I am a physician or a doctor in training.";
export const RESEARCH_CONSENT =
  "I agree to participate in this research study and consent to the use of my study data for research and publication in anonymized form.";
// The snapshot records the same information and declarations shown at enrollment.
export const CLINICIAN_CONSENT_TEXT = [
  PARTICIPANT_INFORMATION,
  NO_TIME_LIMIT,
  ELIGIBILITY_CONFIRMATION,
  RESEARCH_CONSENT,
].join(" ");
export const PATIENT_DEBRIEF =
  "The patient cases came from the MedQA, NEJM and MediQ datasets, which contain medical case reports and educational patient cases. You were not communicating with a patient in real time. An AI system generated the replies using information from the assigned patient case.";
export const STUDY_DEBRIEF_SECTIONS = [
  {
    title: "Purpose of the study",
    text: "This study examines how physicians gather information and reach a diagnosis through a patient dialogue. We use the same patient cases to compare clinical diagnostic reasoning by physicians and AI systems.",
  },
  { title: "About the patient interaction", text: PATIENT_DEBRIEF },
  {
    title: "How the replies were generated",
    text: "The AI was instructed to answer from the patient case, reveal examination or test findings only when asked, and say when information was unavailable. The interaction was simulated. AI-generated replies can contain errors or omit details; they should not be treated as clinical advice. We explain this here so that knowing how the replies were produced does not influence the earlier dialogue.",
  },
  {
    title: "Your study data",
    text: "We recorded your questions, diagnoses, confidence ratings, questionnaire responses and the time spent on study pages and questions. These data are used for research, with findings published in anonymized form. Your questionnaire responses help us understand differences in clinical background and prior AI experience.",
  },
];
