import type { SessionView } from "./types.js";
export const STAGE_KINDS = [
  "information",
  "questionnaire",
  "diagnosis",
  "final_check",
  "completed",
] as const;
export const MAX_QUESTION_ROUNDS = 3;
export function stageSlug(session: SessionView): string {
  return session.status === "completed" ? "outro" : session.step?.id || "intro";
}
export function stagePath(session: SessionView): string {
  return `/study/${encodeURIComponent(stageSlug(session))}`;
}
export function stageProgress(session: SessionView) {
  return {
    step: Math.min(session.step_index + 2, session.total_steps + 1),
    total: session.total_steps + 1,
    title:
      session.status === "completed"
        ? "Thank you"
        : session.step?.kind === "diagnosis"
          ? "Clinical assessment"
          : session.step?.title || "Study",
    subtitle:
      session.step?.kind === "diagnosis"
        ? `Case ${session.completed_cases + 1} of ${session.total_cases}`
        : "Clinical reasoning study",
  };
}
