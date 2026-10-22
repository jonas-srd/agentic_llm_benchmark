import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Settings } from "./lib/config.js";
import type { Database } from "./lib/db.js";
import { safeEqual } from "./lib/security.js";
import { studyRoutes } from "./routes/studies.js";
import { sessionRoutes } from "./routes/sessions.js";
import { exportRoutes } from "./routes/export.js";
export function createApp(
  db: Database,
  settings: Settings,
  peer: (c: Context) => string | undefined = (c) => {
    try {
      return getConnInfo(c).remote.address;
    } catch {
      return undefined;
    }
  },
) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
  });
  app.use("*", (c, next) =>
    bodyLimit({
      maxSize:
        ["/v1/admin/studies", "/v1/admin/media"].includes(c.req.path) &&
        safeEqual(c.req.header("X-Admin-Key") || "", settings.adminKey)
          ? 8500000
          : 256000,
      onError: (c) => c.json({ detail: "Request too large" }, 413),
    })(c, next),
  );
  app.onError((e, c) => {
    if (e instanceof HTTPException)
      return c.json({ detail: e.message }, e.status);
    if (e instanceof ZodError)
      return c.json(
        {
          detail: "Invalid request",
          fields: e.issues.map((i) => ({ path: i.path, message: i.message })),
        },
        422,
      );
    if (e instanceof SyntaxError)
      return c.json({ detail: "Invalid JSON" }, 422);
    console.error("Request failed:", e instanceof Error ? e.name : "unknown");
    return c.json({ detail: "Internal server error" }, 500);
  });
  app.get("/", (c) => c.redirect(settings.frontendUrl));
  app.get("/health/live", (c) => c.json({ status: "ok" }));
  app.get("/health/ready", async (c) => {
    try {
      await db.query("SELECT version FROM app_migrations");
      return c.json({ status: "ready" });
    } catch {
      return c.json({ status: "not_ready" }, 503);
    }
  });
  app.route("/v1", studyRoutes(db, settings, peer));
  app.route("/v1/sessions", sessionRoutes(db, settings));
  app.route("/v1/admin/studies", exportRoutes(db, settings));
  return app;
}
