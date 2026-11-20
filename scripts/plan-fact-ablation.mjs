import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  patientRecord,
  planFactAblation,
} from "../apps/backend/src/domain/facts.ts";
const [baselinePath, outputPrefix] = process.argv.slice(2);
assert(
  baselinePath && outputPrefix,
  "Supply the frozen v8 baseline and an output prefix",
);
for (const p of [25, 50])
  assert(
    !existsSync(`${outputPrefix}-${p}.json`),
    "Refusing to redraw an existing ablation",
  );
const sha = (s) => createHash("sha256").update(s).digest("hex");
const db = new DatabaseSync(baselinePath, { readOnly: true });
const meta = Object.fromEntries(
  db
    .prepare("select * from llm_metadata")
    .all()
    .map((x) => [x.key, x.value]),
);
const seed = randomBytes(32).toString("hex");
const pool = new Map(
  JSON.parse(readFileSync("data/clinical-300/study.json", "utf8")).cases.map(
    (c) => [c.id, c],
  ),
);
const common = {
  version: "nested-fact-id-ablation-v1",
  seed,
  scope: "nonopening_facts_including_image_facts",
  mask_scope: "one_fixed_mask_per_case_for_all_models_and_replicates",
  draw_scheme: "shared_ranking_nested_25_within_50",
  rounding: "nearest_integer_half_up",
  ranking:
    "HMAC-SHA256(seed_hex, JSON.stringify([fact-ablation-v1, case_id, fact_id]))",
  baseline_database_sha256: sha(readFileSync(baselinePath)),
  human_export_sha256: meta.human_export_sha256,
  doctor_prompt_version: meta.doctor_prompt_version,
  created_at: new Date().toISOString(),
};
const plans = Object.fromEntries(
  [25, 50].map((percent) => [
    percent,
    {
      ...common,
      condition_id: `fact_drop_${percent}`,
      removal_percent: percent,
      cases: {},
    },
  ]),
);
for (const r of db
  .prepare(
    "select case_id,patient_prompt_version,fact_pack_sha256,min(run_id) run_id from llm_runs group by case_id,patient_prompt_version,fact_pack_sha256 order by case_id",
  )
  .all()) {
  assert(
    !plans[25].cases[r.case_id],
    "Multiple fact packs for the same baseline case",
  );
  const c = structuredClone(pool.get(r.case_id));
  const a = db
    .prepare(
      "select a.* from llm_case_links l join case_attempts a using(case_attempt_id) where run_id=? limit 1",
    )
    .get(r.run_id);
  assert.equal(a.case_presentation, c.opening);
  const images = patientRecord(c).imageIds;
  c.fact_pack = db
    .prepare(
      "select fact_id id,status,fact_text text from case_facts where case_attempt_id=? order by rowid",
    )
    .all(a.case_attempt_id)
    .filter((f) => !images.has(f.id));
  const record = patientRecord(c);
  assert.equal(record.sha256, r.fact_pack_sha256);
  for (const percent of [25, 50])
    plans[percent].cases[c.id] = {
      ...planFactAblation(record, c.id, seed, percent),
      patient_prompt_version: r.patient_prompt_version,
      opening_sha256: sha(c.opening),
    };
  assert(
    plans[25].cases[c.id].removedIds.every((id) =>
      plans[50].cases[c.id].removedIds.includes(id),
    ),
  );
}
assert.equal(Object.keys(plans[25].cases).length, 146);
for (const percent of [25, 50]) {
  writeFileSync(
    `${outputPrefix}-${percent}.json`,
    JSON.stringify(plans[percent], null, 2),
    { flag: "wx" },
  );
  const values = Object.values(plans[percent].cases);
  console.log(
    JSON.stringify({
      condition: plans[percent].condition_id,
      cases: values.length,
      eligible_facts: values.reduce((n, x) => n + x.eligibleCount, 0),
      removed_facts: values.reduce((n, x) => n + x.removedIds.length, 0),
      removed_image_facts: values.reduce(
        (n, x) =>
          n + x.removedIds.filter((id) => id.startsWith("image_")).length,
        0,
      ),
    }),
  );
}
db.close();
