"use client";
import { useEffect, useRef } from "react";
import { timingClock } from "@/lib/timing-clock";
export function useStudyTiming(
  step: string,
  phase = "page",
  round = 0,
  persist = true,
) {
  const read = useRef(() => ({ elapsed_ms: 0, active_ms: 0 }));
  const flush = useRef(() => {});
  useEffect(() => {
    const id = crypto.randomUUID();
    const clock = timingClock(performance.now(), !document.hidden);
    read.current = () => clock(performance.now(), !document.hidden);
    const send = () => {
      const duration = read.current();
      if (!persist) return;
      void fetch("/api/timing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({
          id,
          step_id: step,
          phase,
          round_number: round,
          duration,
        }),
      }).catch(() => {});
    };
    flush.current = send;
    send();
    const interval = setInterval(send, 10000);
    document.addEventListener("visibilitychange", send);
    window.addEventListener("pagehide", send);
    return () => {
      send();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", send);
      window.removeEventListener("pagehide", send);
    };
  }, [step, phase, round, persist]);
  return { read: () => read.current(), flush: () => flush.current() };
}
