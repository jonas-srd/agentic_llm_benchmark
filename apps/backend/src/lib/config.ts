import { resolve } from "node:path";
export interface Settings {
  env: string;
  databaseUrl: string;
  adminKey: string;
  sessionSecret: string;
  openrouterKey: string;
  port: number;
  host: string;
  frontendUrl: string;
  llmTimeout: number;
  maxTokens: number;
  pollMs: number;
  previewStudyFile: string;
}
export function settingsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Settings {
  const settings: Settings = {
    env: env.APP_ENV || "development",
    databaseUrl: env.DATABASE_URL || `sqlite:///${resolve("benchmark.db")}`,
    adminKey: env.ADMIN_API_KEY || "",
    sessionSecret: env.SESSION_SECRET || "",
    openrouterKey: env.OPENROUTER_API_KEY || "",
    port: Number(env.PORT || 8000),
    host: env.HOST || (env.APP_ENV === "production" ? "::" : "127.0.0.1"),
    frontendUrl: env.FRONTEND_URL || "http://localhost:3000",
    llmTimeout: Number(env.LLM_TIMEOUT_SECONDS || 90) * 1000,
    maxTokens: Number(env.LLM_MAX_TOKENS || 1800),
    pollMs: Number(env.WORKER_POLL_SECONDS || 2) * 1000,
    previewStudyFile: env.PREVIEW_STUDY_FILE || "",
  };
  if (settings.adminKey.length < 32 || settings.sessionSecret.length < 32)
    throw new Error(
      "ADMIN_API_KEY and SESSION_SECRET must have at least 32 characters",
    );
  if (
    settings.env === "production" &&
    !settings.databaseUrl.startsWith("postgres")
  )
    throw new Error("Production requires PostgreSQL");
  if (settings.llmTimeout < 10000 || settings.llmTimeout > 120000)
    throw new Error("LLM timeout must be between 10 and 120 seconds");
  return settings;
}
