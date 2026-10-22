import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { settingsFromEnv } from "./lib/config.js";
import { Database } from "./lib/db.js";
import { OpenRouter } from "./lib/openrouter.js";
import { claimJob, processRun, processTurn } from "./domain/jobs.js";
const settings = settingsFromEnv(),
  db = new Database(settings.databaseUrl),
  provider = new OpenRouter(settings),
  worker = randomUUID();
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
console.info("Study worker ready");
while (!stopping) {
  try {
    const turn = await claimJob(db, worker, "clinical_turns");
    if (turn) {
      await processTurn(db, provider, turn, worker);
      continue;
    }
    const run = await claimJob(db, worker, "runs");
    if (run) {
      await processRun(db, provider, run, worker);
      continue;
    }
    await setTimeout(settings.pollMs);
  } catch {
    console.warn("Worker waiting for database availability");
    await setTimeout(5000);
  }
}
await db.close();
