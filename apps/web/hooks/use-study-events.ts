"use client";
import { useEffect } from "react";
export function useStudyEvents(step: string) {
  useEffect(() => {
    const send = (type: string) => {
      void fetch("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          events: [
            {
              id: crypto.randomUUID(),
              step_id: step,
              type,
              client_ts: Date.now(),
            },
          ],
        }),
        keepalive: true,
      }).catch(() => {});
    };
    send("case_enter");
    const visibility = () =>
      send(document.hidden ? "page_hidden" : "page_visible");
    document.addEventListener("visibilitychange", visibility);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      send("case_leave");
    };
  }, [step]);
}
