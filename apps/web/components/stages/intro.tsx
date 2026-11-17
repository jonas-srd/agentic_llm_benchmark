"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  stagePath,
  PARTICIPANT_INFORMATION,
  NO_TIME_LIMIT,
  ELIGIBILITY_CONFIRMATION,
  RESEARCH_CONSENT,
  type SessionView,
  type StudyInfo,
} from "@clinical/shared";
import { api, errorMessage } from "@/lib/client";
import { StudyHeader } from "../study-header";
import { StageCard, ErrorNotice } from "../ui/stage-card";
import { useStudyTiming } from "@/hooks/use-study-timing";
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
    [eligible, setEligible] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const router = useRouter();
  const timing = useStudyTiming("intro", "page", 0, false);
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
        ...(info.workflow === "clinician"
          ? { eligibility_confirmed: eligible }
          : {}),
        consent_version: info.consent_version,
        intro_timing: timing.read(),
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
          eyebrow={info.is_demo ? "TEST SESSION" : "WELCOME"}
          title="Clinical diagnosis study"
        >
          {info.is_demo && (
            <p className="note">
              This is a practice session. To receive a completion code, open
              your personal study link from Prolific before you begin.
            </p>
          )}
          <div className="prose">
            <h2>How it works</h2>
            <p>
              You will review patient cases and enter one diagnosis per patient
              case. Before giving your diagnosis, you will interact with each
              patient and ask three questions, one at a time. A short
              questionnaire follows the patient cases.
            </p>
            <p>{NO_TIME_LIMIT}</p>
          </div>
          <div className="consent-copy">
            <h2>Information and consent</h2>
            <p>
              {info.workflow === "clinician"
                ? PARTICIPANT_INFORMATION
                : info.consent_text}
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
              {info.workflow === "clinician" && (
                <label className="check-line">
                  <input
                    type="checkbox"
                    required
                    checked={eligible}
                    onChange={(e) => setEligible(e.target.checked)}
                  />
                  <span>{ELIGIBILITY_CONFIRMATION}</span>
                </label>
              )}
              <label className="check-line">
                <input
                  type="checkbox"
                  required
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span>
                  {info.workflow === "clinician"
                    ? RESEARCH_CONSENT
                    : "I have read the information above and consent to participate."}
                </span>
              </label>
              <div className="action-row">
                <span className="muted">
                  Instructions follow before your first patient case.
                </span>
                <button
                  disabled={
                    !consent ||
                    (info.workflow === "clinician" && !eligible) ||
                    busy
                  }
                >
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
      </main>
    </>
  );
}
