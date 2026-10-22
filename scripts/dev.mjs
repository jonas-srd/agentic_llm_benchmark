import { spawn } from "node:child_process";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const env = {
  ...process.env,
  APP_ENV: "development",
  BACKEND_URL: process.env.BACKEND_URL || "http://127.0.0.1:8000",
  PUBLIC_FRONTEND_URL:
    process.env.PUBLIC_FRONTEND_URL || "http://localhost:3000",
};
if (!env.ADMIN_API_KEY || !env.SESSION_SECRET) {
  console.error(
    "Create .env from .env.example and set ADMIN_API_KEY and SESSION_SECRET first.",
  );
  process.exit(1);
}
async function run(args) {
  await new Promise((done, reject) => {
    const p = spawn(process.execPath, args, {
      cwd: root,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? done() : reject(new Error(`Setup exited with ${code}`)),
    );
  });
}
await run([
  "node_modules/typescript/bin/tsc",
  "-p",
  "packages/shared/tsconfig.json",
]);
await run(["--import", "tsx", "apps/backend/src/migrate.ts"]);
const processes = [
  ["--import", "tsx", "apps/backend/src/index.ts"],
  ["--import", "tsx", "apps/backend/src/worker.ts"],
  [
    "node_modules/next/dist/bin/next",
    "dev",
    "apps/web",
    "-p",
    process.env.WEB_PORT || "3000",
  ],
].map((args) =>
  spawn(process.execPath, args, {
    cwd: root,
    env,
    stdio: "inherit",
    windowsHide: true,
  }),
);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const p of processes) {
    if (process.platform === "win32" && p.pid)
      spawn("taskkill", ["/PID", String(p.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    else p.kill("SIGTERM");
  }
}
for (const p of processes) {
  p.on("error", (e) => {
    console.error(e.message);
    stop();
  });
  p.on("exit", () => stop());
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
