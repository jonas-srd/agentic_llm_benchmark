import type { StudyStep, Draft } from "./schemas.js";
export interface SessionView {
  id: string;
  status: string;
  step_index: number;
  total_steps: number;
  revision: number;
  step: Omit<StudyStep, "case_id"> | null;
  workflow: string;
  is_demo: boolean;
  total_cases: number;
  completed_cases: number;
  include_in_analysis: boolean | null;
  completion_url?: string | null;
}
export interface StudyInfo {
  id: string;
  title: string;
  consent_text: string;
  consent_version: string;
  version: string;
  is_demo: boolean;
  workflow: string;
  cases_per_participant: number;
  pool_size: number;
  sources: string[];
  source_counts: Record<string, number>;
  steps: Array<Pick<StudyStep, "id" | "title" | "kind">>;
}
export interface TurnView {
  id: string;
  round_number: number;
  target: "patient" | "lab";
  question: string;
  tests: string[];
  status: string;
  response: string | null;
  images: Array<{ url: string; caption: string }>;
  created_at: number;
  finished_at: number | null;
}
export interface CaseView {
  id: string;
  step_id: string;
  title: string;
  opening: string;
  available_tests: string[];
  rounds_used: number;
  max_rounds: number;
  can_ask: boolean;
  pending: boolean;
  turns: TurnView[];
  diagnosis: string | null;
  confidence: number | null;
  completed_at: number | null;
  draft: Draft;
}
