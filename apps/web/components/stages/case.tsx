"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { stagePath, type CaseView, type SessionView } from "@clinical/shared";
import { api, errorMessage } from "@/lib/client";
import { useDraftAutosave } from "@/hooks/use-draft-autosave";
import { useStudyEvents } from "@/hooks/use-study-events";
import { ErrorNotice } from "../ui/stage-card";
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
          aria-label="Open original case image at full size"
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
        <button onClick={() => window.location.reload()}>Reload case</button>
      ) : (
        <p role="status">Loading your case…</p>
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
    [target, setTarget] = useState<"patient" | "lab">("patient"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const draft = useDraftAutosave(initial.step_id, initial.draft);
  const router = useRouter();
  const confirmation = useRef<HTMLDialogElement>(null);
  const questionRequest = useRef<{ key: string; id: string } | null>(null);
  const diagnosisRequest = useRef<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  useStudyEvents(initial.step_id);
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
  }, [data.turns]);
  async function ask() {
    setBusy(true);
    setError("");
    try {
      await draft.flush();
      const payload = {
        target,
        question: target === "patient" ? draft.value.question.trim() : "",
        tests: target === "lab" ? draft.value.tests : [],
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
      draft.update(target === "patient" ? { question: "" } : { tests: [] });
    } catch (e) {
      setError(errorMessage(e));
      try {
        await reconcile();
      } catch {
        /* Keep the original error and allow an explicit reload. */
      }
    } finally {
      setBusy(false);
    }
  }
  async function diagnose() {
    setBusy(true);
    setError("");
    diagnosisRequest.current ??= crypto.randomUUID();
    try {
      await draft.flush();
      const next = await api<SessionView>(`cases/${data.step_id}/diagnosis`, {
        request_id: diagnosisRequest.current,
        revision,
        diagnosis: draft.value.diagnosis.trim(),
        confidence: draft.value.confidence,
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
  const canSubmit = !locked && draft.value.diagnosis.trim().length > 0;
  return (
    <>
      <div className="task-heading">
        <div>
          <p className="eyebrow">
            CASE {session.completed_cases + 1} OF {session.total_cases}
          </p>
          <h1>Clinical assessment</h1>
          <p>Gather evidence, then submit your most likely diagnosis.</p>
        </div>
        <div className="round-summary">
          <span>Question rounds used</span>
          <div
            className="round-dots"
            aria-label={`${data.rounds_used} of 3 rounds used`}
          >
            {[1, 2, 3].map((n) => (
              <span key={n} className={n <= data.rounds_used ? "used" : ""}>
                {n <= data.rounds_used ? "✓" : n}
              </span>
            ))}
            <strong>{data.rounds_used} / 3</strong>
          </div>
        </div>
      </div>
      <ErrorNotice message={error || draft.error} />
      {(error || draft.error) && (
        <button
          className="text-button"
          onClick={() => window.location.reload()}
        >
          Reload saved case
        </button>
      )}
      <div className="clinical-grid">
        <div className="clinical-left">
          <section className="panel case-brief">
            <div className="panel-label">
              <span className="mini-icon" aria-hidden="true">
                ▤
              </span>{" "}
              CASE PRESENTATION
            </div>
            <h2>{data.title}</h2>
            <p>{data.opening}</p>
            <div className="case-note">
              Ask the patient about their history. Request examination findings,
              laboratory results and available images from the lab.
            </div>
          </section>
          <section className="panel diagnosis-panel">
            <div className="panel-label">
              <span className="mini-icon" aria-hidden="true">
                ✓
              </span>{" "}
              YOUR ASSESSMENT
            </div>
            <h2>Most likely diagnosis</h2>
            <p className="muted">
              You can submit now or gather more evidence first.
            </p>
            <label className="sr-only" htmlFor="diagnosis">
              Most likely diagnosis
            </label>
            <textarea
              id="diagnosis"
              rows={3}
              maxLength={2000}
              placeholder="Enter one diagnosis…"
              value={draft.value.diagnosis}
              disabled={busy}
              onChange={(e) => {
                diagnosisRequest.current = null;
                draft.update({ diagnosis: e.target.value });
              }}
            />
            <div className="confidence-heading">
              <label htmlFor="confidence">Your confidence</label>
              <output htmlFor="confidence">{draft.value.confidence}%</output>
            </div>
            <input
              id="confidence"
              type="range"
              min={0}
              max={100}
              step={1}
              disabled={busy}
              value={draft.value.confidence}
              onChange={(e) => {
                diagnosisRequest.current = null;
                draft.update({ confidence: Number(e.target.value) });
              }}
            />
            <div className="range-labels">
              <span>Not confident</span>
              <span>Very confident</span>
            </div>
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
          </section>
        </div>
        <section className="panel conversation-panel">
          <div className="conversation-heading">
            <div>
              <p className="panel-label">GATHER EVIDENCE</p>
              <h2>Patient & investigations</h2>
            </div>
            <span className="remaining">
              {3 - data.rounds_used} rounds left
            </span>
          </div>
          <div
            className="transcript"
            aria-live="polite"
            aria-relevant="additions text"
          >
            {!data.turns.length && (
              <div className="empty-conversation">
                <span className="conversation-symbol" aria-hidden="true">
                  ☏
                </span>
                <h3>What would you like to know?</h3>
                <p>
                  Ask the patient about their history or request tests. Each
                  submission uses one round.
                </p>
              </div>
            )}
            {data.turns.map((t) => (
              <article className="exchange" key={t.id}>
                <div className="exchange-meta">
                  ROUND {t.round_number}
                  <span>
                    {t.target === "patient" ? "Patient history" : "Laboratory"}
                  </span>
                </div>
                <div className="question-bubble">
                  <strong>You</strong>
                  <p>
                    {t.target === "patient" ? t.question : t.tests.join(", ")}
                  </p>
                </div>
                <div
                  className={`answer-bubble${["failed", "interrupted"].includes(t.status) ? " failed" : ""}`}
                >
                  <strong>
                    {t.target === "patient" ? "Patient" : "Laboratory"}
                  </strong>
                  {["queued", "running"].includes(t.status) ? (
                    <p className="thinking" role="status">
                      Preparing a response<span>…</span>
                    </p>
                  ) : t.status === "succeeded" ? (
                    <>
                      <p>{t.response}</p>
                      {t.images?.map((image) => (
                        <CaseImage key={image.url} image={image} />
                      ))}
                    </>
                  ) : (
                    <p>
                      This response could not be completed. Your round has been
                      returned.{" "}
                      {data.can_ask
                        ? "You can try another question or submit your diagnosis."
                        : "Please submit your diagnosis with the available evidence."}
                    </p>
                  )}
                </div>
              </article>
            ))}
            <div ref={bottom} />
          </div>
          <div className="composer">
            {data.can_ask || data.pending ? (
              <>
                <div
                  className="composer-tabs"
                  role="tablist"
                  aria-label="Evidence source"
                >
                  <button
                    role="tab"
                    aria-selected={target === "patient"}
                    aria-controls="evidence-panel"
                    id="patient-tab"
                    className={target === "patient" ? "active" : ""}
                    disabled={locked}
                    onClick={() => setTarget("patient")}
                  >
                    Ask patient
                  </button>
                  <button
                    role="tab"
                    aria-selected={target === "lab"}
                    aria-controls="evidence-panel"
                    id="lab-tab"
                    className={target === "lab" ? "active" : ""}
                    disabled={locked}
                    onClick={() => setTarget("lab")}
                  >
                    Tests & imaging
                  </button>
                </div>
                <div
                  role="tabpanel"
                  id="evidence-panel"
                  aria-labelledby={
                    target === "patient" ? "patient-tab" : "lab-tab"
                  }
                >
                  {target === "patient" ? (
                    <>
                      <label className="sr-only" htmlFor="patient-question">
                        Question for the patient
                      </label>
                      <textarea
                        id="patient-question"
                        rows={3}
                        maxLength={2000}
                        placeholder="What would you like to ask the patient?"
                        disabled={locked}
                        value={draft.value.question}
                        onChange={(e) =>
                          draft.update({ question: e.target.value })
                        }
                      />
                    </>
                  ) : (
                    <fieldset className="test-options" disabled={locked}>
                      <legend>Select investigations for this round</legend>
                      {data.available_tests.map((t) => (
                        <label key={t}>
                          <input
                            type="checkbox"
                            checked={draft.value.tests.includes(t)}
                            onChange={(e) =>
                              draft.update({
                                tests: e.target.checked
                                  ? [...draft.value.tests, t].slice(0, 10)
                                  : draft.value.tests.filter((x) => x !== t),
                              })
                            }
                          />
                          {t}
                        </label>
                      ))}
                      {!data.available_tests.length && (
                        <p>No tests are available for this case.</p>
                      )}
                      <p className="muted">
                        Select up to 10 investigations in one round. Images
                        appear with the corresponding results when available.
                      </p>
                    </fieldset>
                  )}
                  <div className="composer-actions">
                    <span>Uses 1 question round</span>
                    <button
                      onClick={ask}
                      disabled={
                        locked ||
                        !data.can_ask ||
                        (target === "patient"
                          ? !draft.value.question.trim()
                          : !draft.value.tests.length)
                      }
                    >
                      {data.pending
                        ? "Waiting for response…"
                        : busy
                          ? "Saving…"
                          : target === "patient"
                            ? "Send question"
                            : "Request selected tests"}{" "}
                      <span aria-hidden="true">↑</span>
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="rounds-finished">
                <strong>
                  {data.rounds_used >= 3
                    ? "All three rounds are complete."
                    : "No further questions are available."}
                </strong>
                <p>
                  Review the evidence and submit your diagnosis to continue.
                </p>
              </div>
            )}
          </div>
        </section>
      </div>
      <dialog ref={confirmation} className="dialog">
        <p className="eyebrow">CONFIRM YOUR ASSESSMENT</p>
        <h2>Submit this diagnosis?</h2>
        <p className="confirmation-diagnosis">{draft.value.diagnosis}</p>
        <p>
          Confidence: <strong>{draft.value.confidence}%</strong> ·{" "}
          {data.rounds_used} of 3 rounds used
        </p>
        <p>
          This answer is final. You will continue to the{" "}
          {session.completed_cases + 1 === session.total_cases
            ? "final check"
            : "next case"}
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
          <button disabled={busy} onClick={diagnose}>
            {busy ? "Submitting…" : "Confirm diagnosis"}
          </button>
        </div>
      </dialog>
    </>
  );
}
