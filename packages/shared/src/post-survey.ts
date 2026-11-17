import { StepSchema } from "./schemas.js";
export {
  POST_SURVEY_STEP as LEGACY_POST_SURVEY_STEP,
  POST_SURVEY_VERSION as LEGACY_POST_SURVEY_VERSION,
} from "./post-survey-v1.js";

export const POST_SURVEY_ID = "post-survey";
export const POST_SURVEY_VERSION = "clinician-post-survey-v2";
export const POST_SURVEY_IDS = [
  POST_SURVEY_ID,
  "post-survey-experience",
  "post-survey-tools",
] as const;
export const isPostSurvey = (id: string) =>
  (POST_SURVEY_IDS as readonly string[]).includes(id);

// Solmonovich et al. (2025), S1, Q2. Original labels and order;
// "Not yet specialized" is our addition. See docs/confidence-and-survey.md.
const specialties = [
  "Anesthesiology",
  "Cardiology",
  "Critical care",
  "Dermatology",
  "Emergency medicine",
  "Endocrinology",
  "Family medicine",
  "Gastroenterology",
  "Geriatrics",
  "Hematology Oncology",
  "Infectious disease",
  "Internal medicine",
  "Interventional radiology",
  "Nephrology",
  "Neurology",
  "Neurosurgery",
  "Obstetrics and gynecology",
  "Ophthalmology",
  "Orthopedics",
  "Otolaryngology",
  "Pain medicine",
  "Palliative care",
  "Pathology",
  "Pediatrics",
  "Physical medicine and rehabilitation",
  "Plastic surgery",
  "Psychiatry",
  "Pulmonology",
  "Radiology",
  "Rheumatology",
  "Sports medicine",
  "Surgery",
  "Urology",
  "Other",
  "Not yet specialized",
];
const frequency = [
  "Never",
  "Less than monthly",
  "Monthly",
  "Weekly",
  "Daily or almost daily",
];

export const POST_SURVEY_STEPS = [
  StepSchema.parse({
    id: POST_SURVEY_ID,
    title: "About you",
    kind: "questionnaire",
    instructions: "Please tell us about your clinical background.",
    questions: [
      {
        id: "age_group",
        label: "Age",
        kind: "choice",
        options: [
          "Under 20 years old",
          "20-30 years old",
          "31-40 years old",
          "41-50 years old",
          ">50 years old",
          "Prefer not to say",
        ],
      },
      {
        id: "clinical_role",
        label: "Role",
        kind: "choice",
        options: [
          "Attending physician",
          "Fellow physician",
          "Resident physician",
          "Other physician or doctor in training",
        ],
      },
      {
        id: "specialty",
        label: "Specialty",
        kind: "choice",
        options: specialties,
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
    ],
  }),
  StepSchema.parse({
    id: POST_SURVEY_IDS[1],
    title: "Your experience",
    kind: "questionnaire",
    instructions:
      "For the AI questions, please think about your experience before taking part in this study.",
    questions: [
      // S1 Q6 verbatim. Awareness is not a substitute measure of AI literacy.
      {
        id: "ai_awareness",
        section: "AI experience",
        label:
          "Have you heard of AI-powered virtual assistants for medical support, like ChatGPT or similar tools?",
        kind: "boolean",
      },
      {
        id: "ai_use_frequency",
        label:
          "Before this study, how often did you use AI-powered virtual assistants, like ChatGPT or similar tools?",
        kind: "choice",
        options: frequency,
      },
      {
        id: "clinical_ai_use_frequency",
        label:
          "Before this study, how often did you use AI-powered virtual assistants for medical support?",
        kind: "choice",
        options: frequency,
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
      // Brunyé et al.: plural patient cases, retaining the six-point response scale.
      {
        id: "perceived_difficulty",
        label:
          "Please rate on the following scale your opinion of the level of diagnostic difficulty of these patient cases.",
        kind: "likert",
        minimum: 1,
        maximum: 6,
        lower_label: "Very easy",
        upper_label: "Very challenging",
      },
      // SEQ wording, changing the referent from task completion to this website.
      {
        id: "usability",
        label: "How easy or difficult was it to use this website?",
        kind: "likert",
        lower_label: "Very difficult",
        upper_label: "Very easy",
      },
    ],
  }),
  StepSchema.parse({
    id: POST_SURVEY_IDS[2],
    title: "Sources and feedback",
    kind: "questionnaire",
    instructions:
      "These questions refer to the patient cases you have just completed.",
    questions: [
      {
        id: "external_support_used",
        label:
          "Did you use any sources or tools outside this website to assess the patient cases?",
        kind: "boolean",
      },
      {
        id: "external_support_types",
        label: "Which sources or tools did you use? Select all that apply.",
        kind: "multiple_choice",
        options: [
          "Medical reference websites, textbooks or guidelines",
          "Search engines",
          "AI tools",
          "Other sources or tools",
        ],
        visible_when: { question_id: "external_support_used", equals: true },
      },
      {
        id: "feedback",
        label: "Any comments or technical problems you would like to share?",
        kind: "text",
        required: false,
      },
    ],
  }),
];
export const POST_SURVEY_STEP = POST_SURVEY_STEPS[0];
