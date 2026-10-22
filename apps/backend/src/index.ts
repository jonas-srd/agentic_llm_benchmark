import { serve } from "@hono/node-server";
import { settingsFromEnv } from "./lib/config.js";
import { Database } from "./lib/db.js";
import { createApp } from "./app.js";
const settings = settingsFromEnv();
const db = new Database(settings.databaseUrl);
const server = serve(
  {
    fetch: createApp(db, settings).fetch,
    hostname: settings.host,
    port: settings.port,
  },
  () => console.log(`Study API listening on port ${settings.port}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () =>
    server.close(() => {
      void db.close().then(() => process.exit(0));
    }),
  );
