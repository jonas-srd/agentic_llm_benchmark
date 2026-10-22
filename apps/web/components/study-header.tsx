"use client";
import { useRef } from "react";
export function StudyHeader({
  step,
  total,
  subtitle,
  demo = false,
}: {
  step: number;
  total: number;
  subtitle: string;
  demo?: boolean;
}) {
  const help = useRef<HTMLDialogElement>(null);
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
            {demo && <span className="preview-label">Preview</span>}
          </div>
          <div className="header-right">
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
          </div>
        </div>
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
      </header>
      <dialog ref={help} className="dialog">
        <h2>Taking part in the study</h2>
        <p>
          For each case, you can use up to three rounds in total to ask the
          patient a question or request tests. You can submit your diagnosis
          earlier if you are ready.
        </p>
        <p>
          Your submitted answers and case drafts are saved. Keep this browser
          and your study link to resume. Do not enter real patient information.
        </p>
        <p>
          If a response fails, that round is returned to you. For other
          problems, contact the researcher through your Prolific study page.
        </p>
        <button onClick={() => help.current?.close()}>Got it</button>
      </dialog>
    </>
  );
}
