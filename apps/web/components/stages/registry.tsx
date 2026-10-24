"use client";
import { useState, useRef, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { stageProgress, stagePath, type SessionView } from "@clinical/shared";
import { api, errorMessage } from "@/lib/client";
import { StudyHeader } from "../study-header";
import { StageCard, ErrorNotice } from "../ui/stage-card";
import { StudyFooter } from "./intro";
import { CaseStage } from "./case";
import { SimulationStage } from "./simulation";
export function StudyStage({ session }: { session: SessionView }) {
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
        <StudyFooter />
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
            : "YOUR CLINICAL BACKGROUND"
      }
      title={final ? "Before you finish" : step.title}
      description={step.instructions || undefined}
    >
      {instructions && (
        <>
          <div className="instruction-list">
            <div>
              <span>1</span>
              <section>
                <h2>Read the case</h2>
                <p>
                  Start with the presenting complaint and the information
                  provided.
                </p>
              </section>
            </div>
            <div>
              <span>2</span>
              <section>
                <h2>Gather evidence</h2>
                <p>
                  Ask the patient a question or select a group of available
                  tests. Both share the same limit of three rounds per case.
                </p>
              </section>
            </div>
            <div>
              <span>3</span>
              <section>
                <h2>Make your diagnosis</h2>
                <p>
                  Submit one most likely diagnosis and your confidence from
                  0–100%. You can finish early. After round three, a diagnosis
                  is required.
                </p>
              </section>
            </div>
          </div>
          <div className="note">
            Cases are independent. Submitted diagnoses are final, and reference
            diagnoses are not shown during the study.
          </div>
        </>
      )}
      {final && (
        <div className="success-note">
          <span aria-hidden="true">✓</span> You have completed all{" "}
          {session.total_cases || "assigned"} cases. Thank you for your
          contribution.
        </div>
      )}
      <form onSubmit={submit}>
        {step.questions.map((q) => (
          <div className="field" key={q.id}>
            {q.kind === "boolean" && q.id === "physician" ? (
              <label className="check-line">
                <input
                  type="checkbox"
                  required={q.required}
                  checked={answers[q.id] === true}
                  onChange={(e) => {
                    request.current = null;
                    setAnswers({ ...answers, [q.id]: e.target.checked });
                  }}
                />
                <span>{q.label}</span>
              </label>
            ) : q.kind === "boolean" ? (
              <fieldset className="boolean-question">
                <legend>{q.label}</legend>
                {[true, false].map((choice) => (
                  <label key={String(choice)}>
                    <input
                      type="radio"
                      name={q.id}
                      required={q.required}
                      checked={answers[q.id] === choice}
                      onChange={() => {
                        request.current = null;
                        setAnswers({ ...answers, [q.id]: choice });
                      }}
                    />
                    {choice ? "Yes" : "No"}
                  </label>
                ))}
              </fieldset>
            ) : (
              <>
                <label htmlFor={q.id}>
                  {q.label}
                  {!q.required && <span className="optional"> (optional)</span>}
                </label>
                {q.kind === "choice" ? (
                  <select
                    id={q.id}
                    required={q.required}
                    value={String(answers[q.id] ?? "")}
                    onChange={(e) => {
                      request.current = null;
                      setAnswers({ ...answers, [q.id]: e.target.value });
                    }}
                  >
                    <option value="" disabled>
                      Select an option
                    </option>
                    {q.options.map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={q.id}
                    type={q.kind === "number" ? "number" : "text"}
                    min={q.minimum ?? undefined}
                    max={q.maximum ?? undefined}
                    maxLength={6000}
                    required={q.required}
                    value={String(answers[q.id] ?? "")}
                    onChange={(e) => {
                      request.current = null;
                      setAnswers({
                        ...answers,
                        [q.id]:
                          q.kind === "number" && e.target.value !== ""
                            ? Number(e.target.value)
                            : e.target.value,
                      });
                    }}
                  />
                )}
              </>
            )}
          </div>
        ))}
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
              ? `${session.total_cases} cases assigned to you`
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
                  : "Complete study"
                : instructions
                  ? "Start first case"
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
        You completed {session.total_cases || "all assigned"} cases. Your
        responses{" "}
        {session.include_in_analysis
          ? "will be included in"
          : "have been marked for exclusion from"}{" "}
        the research analysis.
      </p>
      {session.completion_url ? (
        <a className="button" href={session.completion_url}>
          Return to Prolific →
        </a>
      ) : (
        <div className="note">
          {session.is_demo
            ? "This was a test session. No Prolific submission has been made."
            : "Your session is complete. Please return to your study page."}
        </div>
      )}
      {session.is_demo && (
        <button className="secondary" onClick={restart} disabled={busy}>
          {busy ? "Starting…" : "Start a new test session"}
        </button>
      )}
      <ErrorNotice message={error} />
    </StageCard>
  );
}
