"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { stagePath, type SessionView } from "@clinical/shared";
import { api, errorMessage } from "@/lib/client";
import { StageCard, ErrorNotice } from "../ui/stage-card";
type Run = {
  id: string;
  status: string;
  result?: { diagnosis: string; confidence: number };
  messages?: { sequence: number; role: string; content: string }[];
};
export function SimulationStage({ session }: { session: SessionView }) {
  const [run, setRun] = useState<Run | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const request = useRef<string | null>(null);
  const router = useRouter();
  async function start() {
    setBusy(true);
    try {
      setRun(await api<Run>("runs", {}));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!run || !["queued", "running"].includes(run.status)) return;
    const timer = setInterval(() => {
      void api<Run>(`runs/${run.id}`)
        .then(setRun)
        .catch((e) => setError(errorMessage(e)));
    }, 1500);
    return () => clearInterval(timer);
  }, [run]);
  async function next() {
    setBusy(true);
    request.current ??= crypto.randomUUID();
    try {
      const s = await api<SessionView>(`steps/${session.step!.id}`, {
        request_id: request.current,
        revision: session.revision,
        answers: {},
        include_in_analysis: null,
      });
      router.push(stagePath(s));
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <StageCard
      eyebrow="AGENT COMPARISON"
      title={session.step!.title}
      description={session.step!.instructions}
    >
      <p>
        The doctor agent investigates the case through the patient and
        laboratory agents using the session’s assigned model.
      </p>
      <ErrorNotice message={error} />
      {!run ? (
        <button disabled={busy} onClick={start}>
          Run agent simulation
        </button>
      ) : (
        <>
          <p role="status">
            {["queued", "running"].includes(run.status)
              ? "The agents are investigating this case…"
              : run.status === "succeeded"
                ? "Simulation complete."
                : "The simulation was interrupted or failed. Please contact the researcher."}
          </p>
          {run.result && (
            <div className="note">
              <strong>{run.result.diagnosis}</strong>
              <p>Confidence: {Math.round(run.result.confidence * 100)}%</p>
            </div>
          )}
          {run.status === "succeeded" && (
            <button disabled={busy} onClick={next}>
              Continue →
            </button>
          )}
        </>
      )}
    </StageCard>
  );
}
