import "server-only";
import { cookies } from "next/headers";
import type { SessionView, StudyInfo } from "@clinical/shared";
export const COOKIE = "clinical_session";
export interface Credentials {
  id: string;
  token: string;
  study: string;
  pid: string;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function credentials(): Promise<Credentials | null> {
  try {
    const raw = (await cookies()).get(COOKIE)?.value;
    if (!raw) return null;
    const value = JSON.parse(Buffer.from(raw, "base64url").toString());
    if (
      typeof value.id !== "string" ||
      !/^[0-9a-f-]{36}$/.test(value.id) ||
      typeof value.token !== "string" ||
      !/^[A-Za-z0-9_-]{40,100}$/.test(value.token)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
export async function backend<T>(
  path: string,
  options: { method?: string; body?: unknown; auth?: Credentials | null } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(
      `${process.env.BACKEND_URL || "http://127.0.0.1:8000"}${path}`,
      {
        method: options.method || "GET",
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
        headers: {
          "Content-Type": "application/json",
          ...(options.auth
            ? { Authorization: `Bearer ${options.auth.token}` }
            : {}),
        },
        ...(options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
      },
    );
  } catch {
    throw new ApiError(
      503,
      "The study is temporarily unavailable. Please try again.",
    );
  }
  const data = await res
    .json()
    .catch(() => ({ error: "The study could not complete this request." }));
  if (!res.ok)
    throw new ApiError(
      res.status,
      typeof data.detail === "string"
        ? data.detail
        : typeof data.error === "string"
          ? data.error
          : "Please check your answers and try again.",
    );
  return data;
}
export async function getSession(): Promise<SessionView | null> {
  const auth = await credentials();
  if (!auth) return null;
  try {
    return await backend<SessionView>(`/v1/sessions/${auth.id}`, { auth });
  } catch (e) {
    if (e instanceof ApiError && [401, 404].includes(e.status)) return null;
    throw e;
  }
}
export async function getStudy(id?: string): Promise<StudyInfo> {
  return backend(
    id ? `/v1/studies/${encodeURIComponent(id)}` : directEntryPath(),
  );
}
export function directEntryPath() {
  return process.env.APP_ENV === "production" ? "/v1/demo" : "/v1/preview";
}
