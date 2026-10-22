import { settingsFromEnv } from "./lib/config.js";
import { Database } from "./lib/db.js";
import { migrate } from "./lib/migrations.js";
const db = new Database(settingsFromEnv().databaseUrl);
try {
  await migrate(db);
  console.log("Study database is up to date.");
} finally {
  await db.close();
}
