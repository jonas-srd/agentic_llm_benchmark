"use client";
import { useState, type FormEvent } from "react";
import { POST_SURVEY_STEPS, updateQuestionnaireAnswer } from "@clinical/shared";
import { QuestionnaireFields } from "./questionnaire-fields";
import { StudyHeader } from "./study-header";
import { StageCard } from "./ui/stage-card";

export function PostSurveyPreview() {
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [checked, setChecked] = useState(false);
  const [page, setPage] = useState(0);
  const step = POST_SURVEY_STEPS[page];
  function checkAnswers(event: FormEvent) {
    event.preventDefault();
    if (page < POST_SURVEY_STEPS.length - 1) {
      setPage(page + 1);
      window.scrollTo(0, 0);
    } else setChecked(true);
  }
  return (
    <>
      <StudyHeader step={0} total={0} subtitle="Post-survey" preview />
      <main className="page-shell">
        <StageCard
          eyebrow={`POST-SURVEY PREVIEW · ${page + 1} OF ${POST_SURVEY_STEPS.length}`}
          title={step.title}
          description="Preview the questionnaire. Answers entered here are not saved."
        >
          <p className="muted">{step.instructions}</p>
          <form key={step.id} onSubmit={checkAnswers}>
            <QuestionnaireFields
              questions={step.questions}
              answers={answers}
              onChange={(id, value) => {
                setChecked(false);
                setAnswers(
                  updateQuestionnaireAnswer(step.questions, answers, id, value),
                );
              }}
            />
            {checked && (
              <p role="status">
                All required questions are answered. Preview responses are not
                saved. <a href="/debrief">View debrief</a>
              </p>
            )}
            <div className="action-row">
              {page > 0 ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setPage(page - 1);
                    setChecked(false);
                    window.scrollTo(0, 0);
                  }}
                >
                  Back
                </button>
              ) : (
                <a href="/">Back to study</a>
              )}
              <button type="submit">
                {page < POST_SURVEY_STEPS.length - 1
                  ? "Continue"
                  : "Check answers"}
              </button>
            </div>
          </form>
        </StageCard>
      </main>
    </>
  );
}
