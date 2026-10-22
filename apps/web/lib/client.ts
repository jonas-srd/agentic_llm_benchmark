export class RequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
    });
  } catch {
    throw new RequestError(
      "Connection lost. Your previous answers are saved. Please try again.",
      0,
    );
  }
  const data = await res
    .json()
    .catch(() => ({ error: "Unable to complete this request." }));
  if (!res.ok)
    throw new RequestError(data.error || "Please try again.", res.status);
  return data;
}
export function errorMessage(e: unknown) {
  return e instanceof Error
    ? e.message
    : "Something went wrong. Please try again.";
}
