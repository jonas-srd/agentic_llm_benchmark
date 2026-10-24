"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { stagePath, type SessionView, type StudyInfo } from "@clinical/shared";
import { api, errorMessage } from "@/lib/client";
import { StudyHeader } from "../study-header";
import { StageCard, ErrorNotice } from "../ui/stage-card";
export function IntroStage({
  info,
  existing,
  ids,
  study,
}: {
  info: StudyInfo;
  existing: SessionView | null;
  ids: Record<string, string>;
  study?: string;
}) {
  const [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const router = useRouter();
  const total =
    info.steps.length +
    (info.workflow === "clinician" ? info.cases_per_participant : 0) +
    1;
  async function start(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const session = await api<SessionView>("start", {
        ...(study ? { study, ...ids } : {}),
        consent,
        consent_version: info.consent_version,
      });
      router.push(stagePath(session));
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <>
      <StudyHeader
        step={1}
        total={total}
        subtitle="Welcome"
        demo={info.is_demo}
      />
      <main className="page-shell">
        <StageCard
          eyebrow={info.is_demo ? "TRY THE STUDY" : "WELCOME TO THE STUDY"}
          title="How do you reach a diagnosis?"
          description="Explore clinical cases, gather the evidence you need, and share your diagnostic decisions."
        >
          <div className="intro-facts">
            <div>
              <strong>{info.cases_per_participant}</strong>
              <span>cases assigned to you</span>
            </div>
            <div>
              <strong>Up to 3</strong>
              <span>question rounds per case</span>
            </div>
            <div>
              <strong>Your call</strong>
              <span>diagnose when you are ready</span>
            </div>
          </div>
          <div className="prose">
            <h2>Your role</h2>
            <p>
              You will take the role of the treating physician. Read a case, ask
              the simulated patient for more information or request available
              tests, then submit your most likely diagnosis and confidence.
            </p>
            <p>
              Each question to the patient or request for a group of tests uses
              one round. You have three rounds in total per case. You may submit
              a diagnosis at any point before that limit.
            </p>
          </div>
          {info.is_demo && (
            <div className="note">
              <strong>Test access — no Prolific link needed</strong>
              <p>
                {info.sources.includes("Synthetic")
                  ? "This preview uses fictional practice cases."
                  : `Your ${info.cases_per_participant} cases are drawn from a fixed pool of ${info.pool_size}: ${Object.entries(
                      info.source_counts,
                    )
                      .map(([name, count]) => `${count} ${name}`)
                      .join(", ")}.`}{" "}
                Test responses are saved separately and excluded from the
                research analysis.
              </p>
            </div>
          )}
          <div className="consent-copy">
            <h2>Information and consent</h2>
            <p>{info.consent_text}</p>
            <p>
              Case drafts, submitted answers, question rounds and study timing
              events are recorded. The patient and lab are simulated by an AI
              model. Please do not include real patient information.
            </p>
          </div>
          <ErrorNotice message={error} />
          {existing ? (
            <div className="action-row">
              <p>
                Your {existing.status === "completed" ? "completed" : "current"}{" "}
                session is saved in this browser.
              </p>
              <a className="button" href={stagePath(existing)}>
                {existing.status === "completed"
                  ? "View completion"
                  : "Resume study"}{" "}
                <span aria-hidden="true">→</span>
              </a>
            </div>
          ) : (
            <form onSubmit={start}>
              <label className="check-line">
                <input
                  type="checkbox"
                  required
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span>
                  I have read the information above and consent to participate.
                </span>
              </label>
              <div className="action-row">
                <span className="muted">
                  You can review the instructions before your first case.
                </span>
                <button disabled={!consent || busy}>
                  {busy
                    ? "Starting…"
                    : info.is_demo
                      ? "Start test session"
                      : "Begin study"}{" "}
                  <span aria-hidden="true">→</span>
                </button>
              </div>
            </form>
          )}
        </StageCard>
        <StudyFooter />
      </main>
    </>
  );
}
export function StudyFooter() {
  return (
    <footer className="study-footer">
      Clinical reasoning study <span>•</span> For research purposes
    </footer>
  );
}
