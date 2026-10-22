"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Draft } from "@clinical/shared";
import { api, errorMessage, RequestError } from "@/lib/client";
type Fields = Omit<Draft, "revision">;
export function useDraftAutosave(step: string, initial: Draft) {
  const { revision, ...fields } = initial;
  const [value, setValue] = useState<Fields>(fields),
    [status, setStatus] = useState("All changes saved"),
    [error, setError] = useState("");
  const latest = useRef(fields),
    saved = useRef(JSON.stringify(fields)),
    version = useRef(revision),
    active = useRef<Promise<void> | null>(null),
    conflict = useRef(false),
    mounted = useRef(true);
  const flush = useCallback(async () => {
    if (conflict.current)
      throw new Error("This draft changed in another tab. Reload to continue.");
    if (active.current) return active.current;
    const work = async () => {
      while (saved.current !== JSON.stringify(latest.current)) {
        const snapshot = structuredClone(latest.current);
        if (mounted.current) setStatus("Saving…");
        try {
          const result = await api<Draft>(`cases/${step}/draft`, {
            ...snapshot,
            revision: version.current,
          });
          version.current = result.revision;
          saved.current = JSON.stringify(snapshot);
          if (mounted.current) {
            setError("");
            setStatus("All changes saved");
          }
        } catch (e) {
          if (e instanceof RequestError && e.status === 409)
            conflict.current = true;
          if (mounted.current) {
            setStatus("Changes not yet saved");
            setError(errorMessage(e));
          }
          throw e;
        }
      }
    };
    active.current = work();
    try {
      await active.current;
    } finally {
      active.current = null;
    }
  }, [step]);
  const update = useCallback((patch: Partial<Fields>) => {
    latest.current = { ...latest.current, ...patch };
    setValue(latest.current);
    setStatus("Unsaved changes");
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      void flush().catch(() => {});
    }, 600);
    return () => clearTimeout(timer);
  }, [value, flush]);
  useEffect(() => {
    const leave = (e: BeforeUnloadEvent) => {
      if (saved.current !== JSON.stringify(latest.current)) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, []);
  return { value, update, flush, status, error };
}
