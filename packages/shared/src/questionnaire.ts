import type { StudyStep } from "./schemas.js";

export function questionVisible(
  question: StudyStep["questions"][number],
  answers: Record<string, unknown>,
) {
  return (
    !question.visible_when ||
    answers[question.visible_when.question_id] === question.visible_when.equals
  );
}

export function updateQuestionnaireAnswer(
  questions: StudyStep["questions"],
  answers: Record<string, unknown>,
  id: string,
  value: unknown,
) {
  const next = { ...answers, [id]: value };
  for (const question of questions)
    if (!questionVisible(question, next)) delete next[question.id];
  return next;
}
