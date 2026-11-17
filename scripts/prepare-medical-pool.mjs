import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  StudySchema,
  CLINICIAN_CONSENT_TEXT,
  PARTICIPANT_INFO_VERSION,
} from "@clinical/shared";
import {
  samplePool,
  adaptCase,
  exclusionReason,
  sha256,
  sourceFiles,
  REPOSITORY,
  SOURCE_COMMIT,
  ADAPTER_VERSION,
  SELECTION,
} from "./medical-pool.mjs";
const [repository, destination] = process.argv.slice(2);
if (!repository || !destination)
  throw new Error(
    "Usage: node scripts/prepare-medical-pool.mjs <local-source-repo> <output-directory>",
  );
const repo = resolve(repository),
  out = resolve(destination);
if (
  execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim() !== SOURCE_COMMIT
)
  throw new Error("Source commit changed; review the adapter first");
await mkdir(join(out, "media"), { recursive: true });
let seed;
try {
  seed = (await readFile(join(out, "seed.txt"), "utf8")).trim();
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  seed = randomBytes(32).toString("hex");
  await writeFile(join(out, "seed.txt"), seed + "\n", { flag: "wx" });
}
const datasets = {},
  fileHashes = {};
for (const [source, file] of Object.entries(sourceFiles)) {
  const bytes = await readFile(
    join(repo, "diagnosis_experiment/dataset", file),
  );
  fileHashes[source] = sha256(bytes);
  datasets[source] = bytes
    .toString("utf8")
    .trim()
    .split(/\r?\n/)
    .map(JSON.parse);
}
const selection = samplePool(datasets, seed);
const cases = Object.entries(selection).flatMap(([source, rows]) =>
  rows.map((r) => adaptCase(source, r)),
);
const assets = [];
// Only the source's NEJM image endpoint is retrieved, never arbitrary URLs.
const queue = [...selection.NEJM];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const row = queue.shift();
      if (!row.Image_URL) continue;
      const url = new URL(row.Image_URL);
      if (
        url.origin !== "https://csvc.nejm.org" ||
        url.pathname !== "/ContentServer/images"
      )
        throw new Error("Unrecognized case image origin");
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      });
      const mime_type = response.headers.get("content-type")?.split(";")[0];
      if (
        !response.ok ||
        !["image/jpeg", "image/png", "image/webp"].includes(mime_type)
      )
        throw new Error(
          `Image unavailable for NEJM ${row.id}: ${response.status}`,
        );
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 6_000_000) throw new Error("Image exceeds limit");
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks),
        id = sha256(bytes);
      await writeFile(
        join(out, "media", id + ".json"),
        JSON.stringify({
          id,
          mime_type,
          data_base64: bytes.toString("base64"),
        }),
      );
      cases
        .find((c) => c.id === `nejm-${row.id}`)
        .media.push({
          asset_id: id,
          test: "Original case images",
          caption: "Original case image",
        });
      assets.push({
        case_id: `nejm-${row.id}`,
        id,
        source_url: row.Image_URL,
        bytes: size,
        mime_type,
      });
    }
  }),
);
const manifest = {
  repository: REPOSITORY,
  commit: SOURCE_COMMIT,
  seed,
  selection: SELECTION,
  adapter_version: ADAPTER_VERSION,
  files: fileHashes,
  counts: Object.fromEntries(
    Object.entries(datasets).map(([source, rows]) => [
      source,
      {
        available: rows.length,
        eligible: rows.filter((r) => !exclusionReason(source, r)).length,
        selected: selection[source].length,
      },
    ]),
  ),
  excluded: Object.entries(datasets).flatMap(([source, rows]) =>
    rows
      .filter((r) => exclusionReason(source, r))
      .map((r) => ({ source, id: r.id, reason: exclusionReason(source, r) })),
  ),
  cases: Object.entries(selection).flatMap(([source, rows]) =>
    rows.map((r) => ({
      source,
      id: String(r.id),
      raw_sha256: sha256(JSON.stringify(r)),
    })),
  ),
  assets: assets.sort((a, b) => a.case_id.localeCompare(b.case_id)),
  case_content_sha256: sha256(JSON.stringify(cases)),
};
const digest = sha256(JSON.stringify(manifest));
const demo = JSON.parse(
  await readFile(
    new URL("../apps/backend/src/domain/demo.json", import.meta.url),
    "utf8",
  ),
);
const config = StudySchema.parse({
  ...demo,
  id: `clinical-${cases.length}-${digest.slice(0, 8)}`,
  version: "1",
  title: "Clinical reasoning study",
  is_demo: false,
  cases_per_participant: 5,
  prolific_study_id: null,
  completion_code: null,
  consent_version: PARTICIPANT_INFO_VERSION,
  consent_text: CLINICIAN_CONSENT_TEXT,
  steps: [
    demo.steps[0],
    {
      id: "instructions",
      title: "Instructions",
      kind: "information",
      instructions:
        "For each patient case, ask the patient three questions, one at a time. You can ask about their history or request examination findings, tests or images. After the third answer, enter the single most likely diagnosis and rate your confidence from 1 to 7. After all patient cases, complete a short questionnaire. There is no time limit.",
    },
    demo.steps.at(-1),
  ],
  cases,
  pool_manifest: {
    repository: REPOSITORY,
    commit: SOURCE_COMMIT,
    seed,
    selection: SELECTION,
    adapter_version: ADAPTER_VERSION,
    sha256: digest,
  },
});
await writeFile(
  join(out, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  { flag: "wx" },
);
await writeFile(
  join(out, "study.json"),
  JSON.stringify(config, null, 2) + "\n",
  { flag: "wx" },
);
console.info(
  JSON.stringify({
    study_id: config.id,
    counts: manifest.counts,
    images: assets.length,
    manifest_sha256: digest,
  }),
);
