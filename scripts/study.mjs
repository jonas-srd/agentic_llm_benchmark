import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StudySchema } from "@clinical/shared";
const [command, input, output] = process.argv.slice(2);
const base = process.env.BACKEND_URL || "http://127.0.0.1:8000";
const key = process.env.ADMIN_API_KEY;
if (!key) throw new Error("Set ADMIN_API_KEY in the environment");
async function request(path, body) {
  const res = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-Admin-Key": key, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json();
  if (!res.ok)
    throw new Error(`${res.status}: ${data.detail || "Request failed"}`);
  return data;
}
if (command === "import") {
  const config = StudySchema.parse(JSON.parse(await readFile(input, "utf8")));
  const images = new Set(
    config.cases.flatMap((c) => c.media.map((m) => m.asset_id)),
  );
  for (const id of images) {
    const asset = JSON.parse(
      await readFile(join(dirname(input), "media", `${id}.json`), "utf8"),
    );
    if (asset.id !== id) throw new Error("Image ID mismatch");
    await request("/v1/admin/media", asset);
  }
  const result = await request("/v1/admin/studies", config);
  console.info(`Imported ${result.id}; study is inactive.`);
} else if (["activate", "pause"].includes(command)) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(input || ""))
    throw new Error("Invalid study ID");
  const result = await request(`/v1/admin/studies/${input}/${command}`, {});
  console.info(`Study ${input}: ${result.active ? "active" : "paused"}`);
} else if (command === "export") {
  if (!output) throw new Error("Provide a study ID and output file");
  const pages = [];
  let offset = 0;
  while (true) {
    const page = await request(
      `/v1/admin/studies/${encodeURIComponent(input)}/export?limit=50&offset=${offset}`,
    );
    pages.push(page);
    if (page.sessions.length < 50) break;
    offset += 50;
  }
  await writeFile(
    output,
    JSON.stringify(
      {
        study_id: input,
        exported_at: new Date().toISOString(),
        sessions: pages.flatMap((p) => p.sessions),
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  console.info(`Export written to ${output}`);
} else
  throw new Error(
    "Usage: study.mjs import <json> | activate <id> | pause <id> | export <id> <output.json>",
  );
