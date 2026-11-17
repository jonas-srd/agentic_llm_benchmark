"use client";
import { useRef, useState } from "react";
import { api, errorMessage } from "@/lib/client";
import { StudyInstructions } from "./study-instructions";
export function StudyHeader({
  step,
  total,
  subtitle,
  demo = false,
  preview = false,
}: {
  step: number;
  total: number;
  subtitle: string;
  demo?: boolean;
  preview?: boolean;
}) {
  const help = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
    <>
      <header className="study-header">
        <div className="header-inner">
          <a
            href="/"
            className="brand"
            aria-label="Clinical reasoning study home"
          >
            <span className="brand-mark" aria-hidden="true">
              ✚
            </span>
            <span>
              Clinical reasoning
              <span className="brand-sub">RESEARCH STUDY</span>
            </span>
          </a>
          <div className="header-center">
            {subtitle}
            {(demo || preview) && (
              <span className="preview-label">
                {preview ? "Preview" : "Test session"}
              </span>
            )}
          </div>
          <div className="header-right">
            {preview ? (
              <a href="/">Back to study</a>
            ) : (
              <>
                <span>
                  Step <strong>{step}</strong> of {total}
                </span>
                <button
                  className="help-button"
                  onClick={() => help.current?.showModal()}
                  aria-label="Study help"
                >
                  ?
                </button>
              </>
            )}
          </div>
        </div>
        {!preview && (
          <div
            className="progress-track"
            role="progressbar"
            aria-label="Study progress"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={step}
          >
            <span style={{ width: `${Math.min(step / total, 1) * 100}%` }} />
          </div>
        )}
      </header>
      {!preview && (
        <dialog ref={help} className="dialog">
          <h2>How the study works</h2>
          <StudyInstructions />
          <p>Your progress is saved. Use this browser to resume.</p>
          <p>
            If a response fails, you can retry the question.{" "}
            {demo
              ? "Test responses are excluded from the research analysis."
              : "For help, contact the researcher through Prolific."}
          </p>
          <button onClick={() => help.current?.close()}>Got it</button>
          {demo && step > 1 && (
            <button className="secondary" onClick={restart} disabled={busy}>
              Start a new test session
            </button>
          )}
          {error && <p role="alert">{error}</p>}
        </dialog>
      )}
    </>
  );
}
