"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  stagePath,
  RankedDiagnosesSchema,
  diagnosisSubmission,
  DEFAULT_CONFIDENCE,
  type CaseView,
  type SessionView,
} from "@clinical/shared";
import { api, errorMessage } from "@/lib/client";
import { useDraftAutosave } from "@/hooks/use-draft-autosave";
import { useStudyEvents } from "@/hooks/use-study-events";
import { ErrorNotice } from "../ui/stage-card";
import { useStudyTiming } from "@/hooks/use-study-timing";
import { ResponseProgress } from "../response-progress";
import { ConfidenceSlider } from "../confidence-slider";
function speaker(target: "auto" | "patient" | "lab" | "both") {
  return {
    auto: "Response",
    patient: "Patient",
    lab: "Lab",
    both: "Patient & lab",
  }[target];
}
function CaseImage({ image }: { image: { url: string; caption: string } }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  return (
    <figure className="case-image">
      {failed ? (
        <div role="status">
          Image could not be loaded.{" "}
          <button
            className="text-button"
            onClick={() => {
              setFailed(false);
              setAttempt(attempt + 1);
            }}
          >
            Retry image
          </button>
        </div>
      ) : (
        <a
          href={image.url}
          target="_blank"
          rel="noreferrer"
          aria-label="Open original patient case image at full size"
        >
          {/* Authenticated case evidence must bypass the public Next image cache. */}
          <img
            src={`${image.url}?attempt=${attempt}`}
            alt={image.caption}
            onError={() => setFailed(true)}
          />
        </a>
      )}
      <figcaption>{image.caption} · Open image for full size</figcaption>
    </figure>
  );
}
export function CaseStage({ session }: { session: SessionView }) {
  const [data, setData] = useState<CaseView | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api<CaseView>(`cases/${session.step!.id}`)
      .then((v) => {
        if (active) setData(v);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [session.step]);
  return data ? (
    <CaseWorkspace initial={data} session={session} />
  ) : (
    <div className="stage-card">
      <ErrorNotice message={error} />
      {error ? (
        <button onClick={() => window.location.reload()}>
          Reload patient case
        </button>
      ) : (
        <p role="status">Loading your patient case…</p>
      )}
    </div>
  );
}
function CaseWorkspace({
  initial,
  session,
}: {
  initial: CaseView;
  session: SessionView;
}) {
  const [data, setData] = useState(initial),
    [revision, setRevision] = useState(session.revision),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const draft = useDraftAutosave(initial.step_id, {
    ...initial.draft,
    question: [initial.draft.question, initial.draft.lab_question]
      .filter(Boolean)
      .join("\n\n"),
    lab_question: "",
  });
  const router = useRouter();
  const confirmation = useRef<HTMLDialogElement>(null);
  const questionRequest = useRef<{ key: string; id: string } | null>(null);
  const diagnosisRequest = useRef<string | null>(null);
  const sending = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  useStudyEvents(initial.step_id);
  const pendingTurn = data.turns.find((t) =>
    ["queued", "running"].includes(t.status),
  );
  const timing = useStudyTiming(
    initial.step_id,
    data.can_diagnose ? "diagnosis" : pendingTurn ? "response" : "round",
    data.can_diagnose
      ? 0
      : pendingTurn?.round_number ||
          Math.min(data.rounds_completed + 1, data.max_rounds),
  );
  async function reconcile() {
    const [view, current] = await Promise.all([
      api<CaseView>(`cases/${data.step_id}`),
      api<SessionView>("session"),
    ]);
    setData(view);
    setRevision(current.revision);
    return view;
  }
  useEffect(() => {
    if (!data.pending) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<CaseView>(`cases/${data.step_id}`);
        if (active) {
          setData(next);
          setError("");
        }
      } catch (e) {
        if (active) setError(errorMessage(e));
      } finally {
        if (active) timer = setTimeout(poll, 1500);
      }
    };
    timer = setTimeout(poll, 1000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [data.pending, data.step_id]);
  useEffect(() => {
    if (data.turns.length)
      bottom.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [data.turns.length, data.pending]);
  async function ask() {
    if (
      sending.current ||
      busy ||
      data.pending ||
      !data.can_ask ||
      !draft.value.question.trim()
    )
      return;
    sending.current = true;
    timing.flush();
    setBusy(true);
    setError("");
    try {
      await draft.flush();
      const payload = {
        question: draft.value.question.trim(),
      };
      const key = JSON.stringify(payload);
      if (questionRequest.current?.key !== key)
        questionRequest.current = { key, id: crypto.randomUUID() };
      const next = await api<{ session: SessionView; case: CaseView }>(
        `cases/${data.step_id}/questions`,
        { ...payload, revision, request_id: questionRequest.current.id },
      );
      setData(next.case);
      setRevision(next.session.revision);
      questionRequest.current = null;
      draft.update({ question: "", lab_question: "", tests: [] });
    } catch (e) {
      setError(errorMessage(e));
      try {
        await reconcile();
      } catch {
        /* Keep the original error and allow an explicit reload. */
      }
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  async function diagnose() {
    timing.flush();
    setBusy(true);
    setError("");
    diagnosisRequest.current ??= crypto.randomUUID();
    try {
      await draft.flush();
      const next = await api<SessionView>(`cases/${data.step_id}/diagnosis`, {
        request_id: diagnosisRequest.current,
        revision,
        diagnoses: diagnosisSubmission(draft.value.diagnoses),
      });
      confirmation.current?.close();
      router.push(stagePath(next));
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
      confirmation.current?.close();
      setBusy(false);
    }
  }
  const locked = busy || data.pending;
  const distribution = RankedDiagnosesSchema.safeParse(
    diagnosisSubmission(draft.value.diagnoses),
  );
  const canSubmit = data.can_diagnose && !locked && distribution.success;
  function updateDiagnosis(
    index: number,
    patch: Partial<(typeof draft.value.diagnoses)[number]>,
  ) {
    diagnosisRequest.current = null;
    draft.update({
      diagnoses: draft.value.diagnoses.map((item, i) => {
        if (i !== index) return item;
        const next = { ...item, ...patch };
        if (!next.diagnosis.trim()) next.confidence = DEFAULT_CONFIDENCE;
        return next;
      }),
    });
  }
  return (
    <>
      <div className="task-heading">
        <div>
          <p className="eyebrow">
            PATIENT CASE {session.completed_cases + 1} OF {session.total_cases}
          </p>
          <h1>Patient assessment</h1>
        </div>
        <div className="round-summary">
          <span>Questions answered</span>
          <div
            className="round-dots"
            aria-label={`${Math.min(data.rounds_completed, data.max_rounds)} of ${data.max_rounds} questions answered`}
          >
            {Array.from({ length: data.max_rounds }, (_, i) => i + 1).map(
              (n) => (
                <span
                  key={n}
                  className={n <= data.rounds_completed ? "used" : ""}
                >
                  {n <= data.rounds_completed ? "✓" : n}
                </span>
              ),
            )}
            <strong>
              {Math.min(data.rounds_completed, data.max_rounds)} /{" "}
              {data.max_rounds}
            </strong>
          </div>
        </div>
      </div>
      <ErrorNotice message={error || draft.error} />
      {(error || draft.error) && (
        <button
          className="text-button"
          onClick={() => window.location.reload()}
        >
          Reload saved patient case
        </button>
      )}
      <div className="clinical-grid">
        <div className="clinical-left">
          <section className="panel case-brief">
            <h2>Patient case</h2>
            <p>{data.opening}</p>
          </section>
          {data.can_diagnose && (
            <section className="panel diagnosis-panel" aria-label="Diagnosis">
              <h2>Your diagnosis</h2>
              <p className="muted" id="diagnosis-help">
                Enter the single most likely diagnosis and rate your confidence
                from 1 to 7.
              </p>
              <>
                {draft.value.diagnoses.map((item, index) => (
                  <fieldset
                    className="diagnosis-entry"
                    key={index}
                    disabled={busy}
                    aria-describedby="diagnosis-help"
                  >
                    <legend>Most likely diagnosis</legend>
                    <label
                      className="sr-only"
                      htmlFor={`diagnosis-${index + 1}`}
                    >
                      Diagnosis
                    </label>
                    <textarea
                      id={`diagnosis-${index + 1}`}
                      rows={2}
                      maxLength={2000}
                      placeholder="Enter a diagnosis…"
                      value={item.diagnosis}
                      onChange={(e) =>
                        updateDiagnosis(index, { diagnosis: e.target.value })
                      }
                    />
                    <ConfidenceSlider
                      value={item.confidence}
                      disabled={busy || !item.diagnosis.trim()}
                      onChange={(confidence) =>
                        updateDiagnosis(index, { confidence })
                      }
                    />
                  </fieldset>
                ))}
                {draft.value.diagnoses[0].diagnosis.trim() &&
                  !distribution.success && (
                    <p className="error-notice" role="alert">
                      {distribution.error.issues[0].message}
                    </p>
                  )}
                <button
                  className="full-width"
                  disabled={!canSubmit}
                  onClick={() => confirmation.current?.showModal()}
                >
                  Submit diagnosis <span aria-hidden="true">→</span>
                </button>
                <p className="save-status" role="status">
                  {draft.status}
                </p>
              </>
            </section>
          )}
        </div>
        <section className="panel conversation-panel">
          <div className="conversation-heading">
            <div>
              <h2>Dialogue</h2>
            </div>
          </div>
          <div
            className="transcript"
            aria-live="polite"
            aria-relevant="additions text"
          >
            {!data.turns.length && (
              <div className="empty-conversation">
                <h3>Ask the patient</h3>
              </div>
            )}
            {data.turns.map((t) => (
              <article className="exchange" key={t.id}>
                <div className="exchange-meta">
                  QUESTION {t.round_number}
                  <span>{speaker(t.target)}</span>
                </div>
                <div className="question-bubble">
                  <strong>You</strong>
                  <p>{t.question || t.tests.join(", ")}</p>
                </div>
                {t.status === "succeeded" ? (
                  (
                    t.responses || [
                      { target: t.target, response: t.response || "" },
                    ]
                  ).map((reply) => (
                    <div className="answer-bubble" key={reply.target}>
                      <strong>{speaker(reply.target)}</strong>
                      <p>{reply.response}</p>
                      {(reply.target === "patient" || reply.target === "lab") &&
                        t.images?.map((image) => (
                          <CaseImage key={image.url} image={image} />
                        ))}
                    </div>
                  ))
                ) : (
                  <div
                    className={`answer-bubble${["failed", "interrupted"].includes(t.status) ? " failed" : ""}`}
                  >
                    <strong>{speaker(t.target)}</strong>
                    {["queued", "running"].includes(t.status) ? (
                      <ResponseProgress target={t.target} />
                    ) : (
                      <p>
                        No response received. This question has not been
                        counted.{" "}
                        {data.can_ask
                          ? "Please try again."
                          : "Please wait and reload to retry this question."}
                      </p>
                    )}
                  </div>
                )}
              </article>
            ))}
            <div ref={bottom} />
          </div>
          <div className="composer">
            {data.can_ask || data.pending ? (
              <>
                <div>
                  <label className="sr-only" htmlFor="chat-question">
                    Your question
                  </label>
                  <textarea
                    id="chat-question"
                    enterKeyHint="send"
                    onKeyDown={(e) => {
                      if (
                        e.key !== "Enter" ||
                        e.shiftKey ||
                        e.nativeEvent.isComposing ||
                        e.nativeEvent.keyCode === 229
                      )
                        return;
                      e.preventDefault();
                      if (!e.repeat) void ask();
                    }}
                    rows={3}
                    maxLength={6000}
                    placeholder="Type your question…"
                    disabled={locked}
                    value={draft.value.question}
                    onChange={(e) => draft.update({ question: e.target.value })}
                  />
                  <div className="composer-actions">
                    <button
                      onClick={ask}
                      disabled={
                        locked || !data.can_ask || !draft.value.question.trim()
                      }
                    >
                      {data.pending
                        ? "Waiting for response…"
                        : busy
                          ? "Saving…"
                          : "Send question"}{" "}
                      <span aria-hidden="true">↑</span>
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="rounds-finished">
                <strong>
                  {data.can_diagnose
                    ? "Questions complete."
                    : "Requests are temporarily paused."}
                </strong>
                <p>
                  {data.can_diagnose
                    ? "Enter your diagnosis and confidence rating to continue."
                    : `Please reload in ${Math.max(1, Math.ceil(data.retry_after_seconds / 60))} minutes to ask the remaining questions.`}
                </p>
              </div>
            )}
          </div>
        </section>
      </div>
      <dialog ref={confirmation} className="dialog">
        <h2>Submit this diagnosis?</h2>
        <div className="diagnosis-review">
          <p>{draft.value.diagnoses[0].diagnosis.trim()}</p>
          <strong>Confidence: {draft.value.diagnoses[0].confidence} / 7</strong>
        </div>
        <p>
          This answer is final. You will continue to the{" "}
          {session.completed_cases + 1 === session.total_cases
            ? "final questionnaire"
            : "next patient case"}
          .
        </p>
        <div className="dialog-actions">
          <button
            className="secondary"
            disabled={busy}
            onClick={() => confirmation.current?.close()}
          >
            Keep reviewing
          </button>
          <button disabled={!canSubmit} onClick={diagnose}>
            {busy ? "Submitting…" : "Confirm diagnosis"}
          </button>
        </div>
      </dialog>
    </>
  );
}
