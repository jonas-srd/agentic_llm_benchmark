import { StepSchema } from "./schemas.js";

export const POST_SURVEY_ID = "post-survey";
export const POST_SURVEY_VERSION = "clinician-post-survey-v1";
export const POST_SURVEY_STEP = StepSchema.parse({
  id: POST_SURVEY_ID,
  title: "About you and your experience",
  kind: "questionnaire",
  instructions:
    "Please answer these short questions before finishing the study.",
  questions: [
    {
      id: "age_group",
      section: "About you",
      label: "What is your age group?",
      kind: "choice",
      options: [
        "18–24",
        "25–34",
        "35–44",
        "45–54",
        "55–64",
        "65 or older",
        "Prefer not to say",
      ],
    },
    {
      id: "clinical_role",
      label: "What is your current professional status?",
      kind: "choice",
      options: ["Doctor in training", "Qualified physician"],
    },
    {
      id: "specialty",
      label: "What is your primary specialty?",
      kind: "choice",
      options: [
        "General practice / Family medicine",
        "Internal medicine",
        "Emergency medicine",
        "Surgery",
        "Pediatrics",
        "Psychiatry",
        "Radiology",
        "Other",
        "Not yet specialized",
      ],
    },
    {
      id: "years_in_practice",
      label:
        "How many full years have you worked in clinical practice, including training?",
      kind: "number",
      minimum: 0,
      maximum: 80,
      integer: true,
    },
    {
      id: "patient_care_frequency",
      label: "How often do you currently provide direct patient care?",
      kind: "choice",
      options: [
        "Daily",
        "Several days a week",
        "About once a week",
        "Less than weekly",
        "Not currently providing patient care",
      ],
    },
    {
      id: "ai_use_frequency",
      section: "AI experience",
      label: "Before this study, how often did you use generative AI tools?",
      kind: "choice",
      options: [
        "Never",
        "Less than monthly",
        "Monthly",
        "Weekly",
        "Daily or almost daily",
      ],
    },
    {
      id: "clinical_ai_use_frequency",
      label:
        "Before this study, how often did you use AI tools for clinical tasks?",
      kind: "choice",
      options: [
        "Never",
        "Less than monthly",
        "Monthly",
        "Weekly",
        "Daily or almost daily",
      ],
    },
    {
      id: "ai_familiarity",
      label:
        "How familiar are you with the capabilities and limitations of generative AI?",
      kind: "likert",
      lower_label: "Not at all familiar",
      upper_label: "Extremely familiar",
    },
    {
      id: "case_familiarity",
      section: "Your experience in this study",
      label:
        "How familiar were you with the types of patient cases in this study?",
      kind: "likert",
      lower_label: "Not at all familiar",
      upper_label: "Extremely familiar",
    },
    {
      id: "perceived_difficulty",
      label: "How difficult was it to reach diagnoses in this study?",
      kind: "likert",
      lower_label: "Very easy",
      upper_label: "Very difficult",
    },
    {
      id: "usability",
      label: "How easy was the study website to use?",
      kind: "likert",
      lower_label: "Very difficult",
      upper_label: "Very easy",
    },
    {
      id: "external_support",
      label:
        "Did you use any sources or tools outside this website to assess the patient cases?",
      kind: "choice",
      options: [
        "None",
        "Medical references or search engines",
        "AI tools",
        "Both medical references and AI tools",
        "Other sources or tools",
      ],
    },
    {
      id: "feedback",
      label: "Any comments or technical problems you would like to share?",
      kind: "text",
      required: false,
    },
  ],
});
