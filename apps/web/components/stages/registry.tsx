"use client";
import { useState, useRef, useEffect, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  stageProgress,
  stagePath,
  isPostSurvey,
  POST_SURVEY_IDS,
  updateQuestionnaireAnswer,
  type SessionView,
} from "@clinical/shared";
import { api, errorMessage } from "@/lib/client";
import { StudyHeader } from "../study-header";
import { StageCard, ErrorNotice } from "../ui/stage-card";
import { CaseStage } from "./case";
import { SimulationStage } from "./simulation";
import { useStudyTiming } from "@/hooks/use-study-timing";
import { StudyInstructions } from "../study-instructions";
import { StudyDebrief } from "../study-debrief";
import { QuestionnaireFields } from "../questionnaire-fields";
export function StudyStage({ session }: { session: SessionView }) {
  useStudyTiming(session.status === "completed" ? "outro" : session.step!.id);
  const progress = stageProgress(session);
  return (
    <>
      <StudyHeader {...progress} demo={session.is_demo} />
      <main
        className={`page-shell${session.step?.kind === "diagnosis" ? " task-shell" : ""}`}
      >
        {session.status === "completed" ? (
          <Completed session={session} />
        ) : session.step?.kind === "diagnosis" ? (
          <CaseStage key={session.step.id} session={session} />
        ) : session.step?.kind === "simulation" ? (
          <SimulationStage key={session.step.id} session={session} />
        ) : (
          <FormStage key={session.step?.id} session={session} />
        )}
      </main>
    </>
  );
}
function FormStage({ session }: { session: SessionView }) {
  const router = useRouter();
  const step = session.step!;
  const [answers, setAnswers] = useState<Record<string, unknown>>({}),
    [include, setInclude] = useState<boolean | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const request = useRef<string | null>(null);
  const instructions = step.kind === "information";
  const final = step.kind === "final_check";
  const postSurvey = isPostSurvey(step.id);
  const surveyVersion =
    session.post_survey_version || "clinician-post-survey-v1";
  const storageKey = `survey:${session.id}:${surveyVersion}${surveyVersion === "clinician-post-survey-v1" ? "" : `:${step.id}`}`;
  const [draftLoaded, setDraftLoaded] = useState(false);
  useEffect(() => {
    if (!postSurvey) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || "{}");
      if (saved && typeof saved === "object" && !Array.isArray(saved))
        setAnswers(
          Object.fromEntries(
            Object.entries(saved).filter(([id]) =>
              step.questions.some((q) => q.id === id),
            ),
          ),
        );
    } catch {
      /* Storage can be disabled; submission still works. */
    }
    setDraftLoaded(true);
  }, [postSurvey, storageKey, step.questions]);
  useEffect(() => {
    if (!postSurvey || !draftLoaded) return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(answers));
    } catch {
      /* Keep the in-memory form. */
    }
  }, [answers, draftLoaded, postSurvey, storageKey]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    request.current ??= crypto.randomUUID();
    try {
      const next = await api<SessionView>(`steps/${step.id}`, {
        request_id: request.current,
        revision: session.revision,
        answers,
        include_in_analysis: final ? (session.is_demo ? false : include) : null,
      });
      if (postSurvey) {
        try {
          sessionStorage.removeItem(storageKey);
        } catch {
          /* No persisted draft. */
        }
      }
      router.push(stagePath(next));
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <StageCard
      eyebrow={
        final
          ? "ONE LAST STEP"
          : instructions
            ? "BEFORE YOU BEGIN"
            : postSurvey
              ? surveyVersion === "clinician-post-survey-v1"
                ? "FINAL QUESTIONNAIRE"
                : `QUESTIONNAIRE · ${POST_SURVEY_IDS.indexOf(step.id as (typeof POST_SURVEY_IDS)[number]) + 1} OF ${POST_SURVEY_IDS.length}`
              : "YOUR CLINICAL BACKGROUND"
      }
      title={
        final
          ? "Before you finish"
          : instructions
            ? "How the study works"
            : step.title
      }
      description={
        instructions
          ? `You will assess ${session.total_cases} patient cases. Follow these steps for each patient case.`
          : step.instructions || undefined
      }
    >
      {instructions && <StudyInstructions />}
      {final && (
        <div className="success-note">
          <span aria-hidden="true">✓</span> You have completed all{" "}
          {session.total_cases || "assigned"} patient cases.{" "}
          {session.is_demo
            ? "Submit this page to finish."
            : "Submit this page to get your Prolific completion code."}
        </div>
      )}
      {final && session.workflow === "clinician" && <StudyDebrief />}
      <form onSubmit={submit}>
        <QuestionnaireFields
          questions={step.questions}
          answers={answers}
          disabled={busy}
          onChange={(id, value) => {
            request.current = null;
            setAnswers(
              updateQuestionnaireAnswer(step.questions, answers, id, value),
            );
          }}
        />
        {final && session.is_demo && (
          <p className="note">
            This was a test session. Your responses are automatically excluded
            from the research analysis.
          </p>
        )}
        {final && !session.is_demo && (
          <fieldset className="analysis-options">
            <legend>
              Would you like your responses to be included in the research
              analysis?
            </legend>
            <label>
              <input
                name="include"
                type="radio"
                required
                checked={include === true}
                onChange={() => {
                  request.current = null;
                  setInclude(true);
                }}
              />{" "}
              Yes, include my responses
            </label>
            <label>
              <input
                name="include"
                type="radio"
                required
                checked={include === false}
                onChange={() => {
                  request.current = null;
                  setInclude(false);
                }}
              />{" "}
              No, exclude my responses from analysis
            </label>
            <p className="muted">
              Either choice lets you complete the study and return to Prolific.
            </p>
          </fieldset>
        )}
        <ErrorNotice message={error} />
        <div className="action-row">
          <span className="muted">
            {instructions
              ? "You can reopen these instructions using the ? button."
              : final
                ? "Your decision will be saved with your session."
                : "Please answer all required questions."}
          </span>
          <button
            disabled={busy || (final && !session.is_demo && include === null)}
          >
            {busy
              ? "Saving…"
              : final
                ? session.is_demo
                  ? "Finish test session"
                  : "Complete study and get code"
                : instructions
                  ? "Start first patient case"
                  : "Continue"}{" "}
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </form>
    </StageCard>
  );
}
function Completed({ session }: { session: SessionView }) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function restart() {
    setBusy(true);
    try {
      await api("reset", {});
      window.location.assign("/");
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <StageCard
      eyebrow="STUDY COMPLETE"
      title="Thank you for taking part."
      description="Your responses have been saved."
    >
      <div className="completion-icon" aria-hidden="true">
        ✓
      </div>
      <p>
        You completed {session.total_cases || "all assigned"} patient cases.
        Your responses{" "}
        {session.include_in_analysis
          ? "will be included in"
          : "have been marked for exclusion from"}{" "}
        the research analysis.
      </p>
      {session.completion_url ? (
        <section className="note" aria-label="Prolific completion">
          <p>
            <strong>Your Prolific completion code</strong>
          </p>
          <p className="completion-code">
            <code>
              {new URL(session.completion_url).searchParams.get("cc")}
            </code>
          </p>
          <p>
            Return to Prolific to submit your completion. You can also enter
            this code manually on Prolific.
          </p>
          <p>
            <a className="button" href={session.completion_url}>
              Return to Prolific →
            </a>
          </p>
        </section>
      ) : (
        <div className="note">
          {session.is_demo
            ? "This was a test session. No Prolific submission has been made."
            : "Your session is complete. Please return to your study page."}
        </div>
      )}
      {session.workflow === "clinician" && <StudyDebrief />}
      {session.is_demo && (
        <button className="secondary" onClick={restart} disabled={busy}>
          {busy ? "Starting…" : "Start a new test session"}
        </button>
      )}
      <ErrorNotice message={error} />
    </StageCard>
  );
}
