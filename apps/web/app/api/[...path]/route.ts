import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import {
  backend,
  credentials,
  getSession,
  COOKIE,
  ApiError,
} from "@/lib/backend";
import type { SessionView } from "@clinical/shared";
export const runtime = "nodejs";
const Start = z
  .object({
    study: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .optional(),
    consent: z.literal(true),
    consent_version: z.string().max(100),
    PROLIFIC_PID: z.string().max(64).optional(),
    STUDY_ID: z.string().max(64).optional(),
    SESSION_ID: z.string().max(64).optional(),
  })
  .strict();
async function handle(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    const parts = (await context.params).path;
    const path = parts.join("/");
    const post = request.method === "POST";
    if (post) {
      const allowed = new URL(process.env.PUBLIC_FRONTEND_URL || request.url)
        .origin;
      if (request.headers.get("origin") !== allowed)
        return NextResponse.json(
          { error: "Please submit from the study page." },
          { status: 403 },
        );
    }
    let body: unknown;
    if (post) {
      const reader = request.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (reader)
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 65536) {
            await reader.cancel();
            return NextResponse.json(
              { error: "Request too large" },
              { status: 413 },
            );
          }
          chunks.push(value);
        }
      body = JSON.parse(Buffer.concat(chunks).toString());
    }
    if (path === "health" && !post) {
      await backend("/health/ready");
      return NextResponse.json({ ok: true });
    }
    if (path === "start" && post) {
      const input = Start.parse(body);
      const existing = await getSession();
      if (existing)
        throw new ApiError(
          409,
          "You already have a session. Use Resume study to continue.",
        );
      const { study, ...enrollment } = input;
      const result = await backend<SessionView & { session_token: string }>(
        study ? `/v1/studies/${study}/sessions` : "/v1/preview/sessions",
        { method: "POST", body: enrollment },
      );
      const { session_token, ...safe } = result;
      (await cookies()).set(
        COOKIE,
        Buffer.from(
          JSON.stringify({
            id: safe.id,
            token: session_token,
            study: study || "preview",
            pid: input.PROLIFIC_PID || "",
          }),
        ).toString("base64url"),
        {
          httpOnly: true,
          secure: process.env.APP_ENV === "production",
          sameSite: "lax",
          path: "/",
          maxAge: 72 * 60 * 60,
        },
      );
      return NextResponse.json(safe, { status: 201 });
    }
    const auth = await credentials();
    if (!auth)
      throw new ApiError(
        401,
        "Your session could not be found. Please reopen your study link.",
      );
    if (
      !post &&
      /^cases\/[A-Za-z0-9_-]{1,64}\/media\/[a-f0-9]{64}$/.test(path)
    ) {
      const upstream = await fetch(
        `${process.env.BACKEND_URL || "http://127.0.0.1:8000"}/v1/sessions/${auth.id}/${path}`,
        {
          headers: { Authorization: `Bearer ${auth.token}` },
          cache: "no-store",
          signal: AbortSignal.timeout(15000),
        },
      );
      const mime = upstream.headers.get("content-type") || "";
      if (!upstream.ok)
        throw new ApiError(
          upstream.status,
          "Image not available for this case.",
        );
      if (!["image/jpeg", "image/png", "image/webp"].includes(mime))
        throw new ApiError(502, "Invalid image response.");
      return new NextResponse(await upstream.arrayBuffer(), {
        headers: {
          "Content-Type": mime,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": "inline",
        },
      });
    }
    if (path === "reset" && post) {
      const session = await getSession();
      if (process.env.APP_ENV === "production" || !session?.is_demo)
        throw new ApiError(403, "Only preview sessions can be restarted.");
      (await cookies()).delete(COOKIE);
      return NextResponse.json({ ok: true });
    }
    let suffix: string;
    if (path === "session" && !post) suffix = "";
    else if (post && /^steps\/[A-Za-z0-9_-]{1,64}$/.test(path))
      suffix = `/${path}`;
    else if (!post && /^cases\/[A-Za-z0-9_-]{1,64}$/.test(path))
      suffix = `/${path}`;
    else if (
      post &&
      /^cases\/[A-Za-z0-9_-]{1,64}\/(questions|diagnosis|draft)$/.test(path)
    )
      suffix = `/${path}`;
    else if (post && ["events", "runs"].includes(path)) suffix = `/${path}`;
    else if (!post && /^runs\/[a-f0-9-]{36}$/.test(path)) suffix = `/${path}`;
    else throw new ApiError(404, "Not found");
    return NextResponse.json(
      await backend(`/v1/sessions/${auth.id}${suffix}`, {
        method: request.method,
        body,
        auth,
      }),
    );
  } catch (e) {
    const status =
      e instanceof ApiError
        ? e.status
        : e instanceof z.ZodError || e instanceof SyntaxError
          ? 422
          : 500;
    return NextResponse.json(
      {
        error:
          e instanceof ApiError
            ? e.message
            : status === 422
              ? "Please check your answers and try again."
              : "Unable to complete this request.",
      },
      { status },
    );
  }
}
export const GET = handle;
export const POST = handle;
