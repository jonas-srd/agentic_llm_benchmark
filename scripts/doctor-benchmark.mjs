// node --env-file=.env --import tsx scripts/doctor-benchmark.mjs INPUT.sqlite OUTPUT.sqlite [pilot|run|repair|verify]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, constants } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  runSimulation,
  PROMPT_VERSION,
  DOCTOR,
} from "../apps/backend/src/domain/agents.ts";
import { patientRecord } from "../apps/backend/src/domain/facts.ts";
import {
  PATIENT_CHAT_VERSION,
  PATIENT_PROMPT,
  usesPatientFactIds,
} from "../apps/backend/src/domain/patient.ts";
import { PATIENT_PROMPT_V3 } from "../apps/backend/src/domain/patient-prompt-v3.ts";
import {
  judgeDiagnoses,
  JUDGE_PROMPT_VERSION,
  JUDGE_PROMPT,
} from "../apps/backend/src/domain/judge.ts";
import { SUPPORT_MODEL } from "../apps/backend/src/domain/protocol.ts";
import {
  OpenRouter,
  ProviderError,
} from "../apps/backend/src/lib/openrouter.ts";
import { settingsFromEnv } from "../apps/backend/src/lib/config.ts";

const models = [
  "openai/gpt-6.1-sol",
  "anthropic/claude-fable-5.2",
  "moonshotai/kimi-k3.1-pro",
];
const replicates = [1, 2, 3];
const doctorTokenLimit = 32768;
const concurrency = Number(process.env.DOCTOR_BENCHMARK_CONCURRENCY ?? 96);
assert(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 96);
const doctorSampling = (model) => ({
  reasoning: { effort: "max" },
  ...(model === "moonshotai/kimi-k3.1-pro" ? { temperature: 1 } : {}),
});
const [input, output, mode = "run"] = process.argv.slice(2);
assert(
  input &&
    output &&
    resolve(input) !== resolve(output) &&
    ["run", "pilot", "repair", "verify"].includes(mode),
  "Supply separate input and output databases and a known operation",
);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const seconds = () => Date.now() / 1000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cfg = settingsFromEnv();
assert(cfg.openrouterKey, "OpenRouter key is missing");
const pool = JSON.parse(readFileSync("data/clinical-300/study.json", "utf8"));
const cases = new Map(pool.cases.map((c) => [c.id, c]));
const mediaPath = (id) => resolve("data/clinical-300/media", id + ".json");
function asset(id) {
  assert.match(id, /^[0-9a-f]{64}$/);
  const data = JSON.parse(readFileSync(mediaPath(id), "utf8"));
  assert.equal(data.id, id);
  assert.equal(sha(Buffer.from(data.data_base64, "base64")), id);
  return data;
}
// loadDoctorImages asks only for assets explicitly released in a reply.
const media = {
  query: async (sql, [id]) => {
    assert.equal(
      sql,
      "SELECT mime_type,data_base64 FROM case_media WHERE id=$1",
    );
    return { rows: [asset(id)], rowCount: 1 };
  },
};
const inputHash = sha(readFileSync(input));
if (!existsSync(output)) copyFileSync(input, output, constants.COPYFILE_EXCL);
const db = new DatabaseSync(output);
if (db.prepare("select 1 from sqlite_master where name='llm_runs'").get())
  assert(
    db
      .prepare("pragma table_info(llm_runs)")
      .all()
      .some((c) => c.name === "replicate"),
    "Use a fresh output for the replicated benchmark",
  );
db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=20000;
CREATE TABLE IF NOT EXISTS llm_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS llm_provider_errors(run_id INTEGER REFERENCES llm_runs, failed_at_unix REAL, error TEXT, PRIMARY KEY(run_id,failed_at_unix));
CREATE TABLE IF NOT EXISTS llm_runs(run_id INTEGER PRIMARY KEY,case_id TEXT NOT NULL,patient_prompt_version TEXT NOT NULL,doctor_model TEXT NOT NULL,replicate INTEGER NOT NULL CHECK(replicate BETWEEN 1 AND 3),doctor_reasoning_effort TEXT NOT NULL,temperature_target REAL NOT NULL,temperature_sent REAL, fact_pack_sha256 TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', error TEXT, diagnosis TEXT, confidence INTEGER CHECK(confidence BETWEEN 1 AND 7), confidence_scale TEXT, judge_verdict TEXT,started_at_unix REAL,finished_at_unix REAL, UNIQUE(case_id,doctor_model,replicate));
CREATE TABLE IF NOT EXISTS llm_case_links(run_id INTEGER REFERENCES llm_runs,case_attempt_id TEXT REFERENCES case_attempts,PRIMARY KEY(run_id,case_attempt_id));
CREATE TABLE IF NOT EXISTS llm_calls(run_id INTEGER REFERENCES llm_runs,sequence INTEGER,role TEXT NOT NULL,model TEXT NOT NULL,request_sha256 TEXT NOT NULL,response_json TEXT NOT NULL,started_at_unix REAL,finished_at_unix REAL,PRIMARY KEY(run_id,sequence));
CREATE TABLE IF NOT EXISTS llm_rounds(run_id INTEGER REFERENCES llm_runs,round_number INTEGER,doctor_question TEXT NOT NULL,patient_answer TEXT NOT NULL,fact_ids_json TEXT NOT NULL,released_image_ids_json TEXT NOT NULL,PRIMARY KEY(run_id,round_number));
CREATE TABLE IF NOT EXISTS llm_image_assets(image_id TEXT PRIMARY KEY,mime_type TEXT NOT NULL,image_data BLOB NOT NULL);
CREATE VIEW IF NOT EXISTS llm_response_images AS
SELECT r.run_id,r.round_number,i.value AS image_id FROM llm_rounds r,json_each(r.released_image_ids_json) i;
CREATE VIEW IF NOT EXISTS llm_case_results AS SELECT r.*,SUM(CAST(json_extract(c.response_json,'$.usage.cost') AS REAL)) AS reported_cost_usd FROM llm_runs r LEFT JOIN llm_calls c USING(run_id) GROUP BY r.run_id;
CREATE VIEW IF NOT EXISTS llm_round_results AS
SELECT r.case_id,r.doctor_model,r.replicate,r.patient_prompt_version,x.*,
       d.started_at_unix AS question_started_at_unix,d.finished_at_unix AS question_ready_at_unix,
       CAST(ROUND((d.finished_at_unix-d.started_at_unix)*1000) AS INTEGER) AS question_generation_ms,
       p.started_at_unix AS patient_started_at_unix,p.finished_at_unix AS answer_ready_at_unix,
       CAST(ROUND((p.finished_at_unix-p.started_at_unix)*1000) AS INTEGER) AS patient_generation_ms
FROM llm_rounds x JOIN llm_runs r USING(run_id)
JOIN llm_calls d ON d.run_id=x.run_id AND d.sequence=2*(x.round_number-1)
JOIN llm_calls p ON p.run_id=x.run_id AND p.sequence=2*(x.round_number-1)+1;
CREATE VIEW IF NOT EXISTS physician_llm_comparison AS
SELECT s.session_type,s.included_in_main_analysis,h.session_id,h.case_attempt_id,h.case_id,
       h.dataset,h.reference_diagnosis,h.physician_diagnosis,h.confidence AS physician_confidence,h.judge_verdict AS physician_verdict,
       r.run_id,r.doctor_model,r.replicate,r.patient_prompt_version,r.status AS llm_status,
       r.diagnosis AS llm_diagnosis,r.confidence AS llm_confidence,r.judge_verdict AS llm_verdict
FROM llm_case_links l JOIN case_attempts h USING(case_attempt_id) JOIN sessions s USING(session_id)
JOIN llm_runs r ON r.run_id=l.run_id;`);
function meta(k, v) {
  db.prepare("insert or ignore into llm_metadata values(?,?)").run(k, v);
  assert.equal(
    db.prepare("select value from llm_metadata where key=?").get(k).value,
    v,
  );
}
db.exec("begin immediate");
try {
  meta("human_export_sha256", inputHash);
  meta("doctor_models", JSON.stringify(models));
  meta("patient_model", SUPPORT_MODEL);
  meta("judge_model", SUPPORT_MODEL);
  meta("doctor_prompt_version", PROMPT_VERSION);
  meta("judge_prompt_version", JUDGE_PROMPT_VERSION);
  meta(PROMPT_VERSION, DOCTOR);
  meta(JUDGE_PROMPT_VERSION, JUDGE_PROMPT);
  meta(PATIENT_CHAT_VERSION, PATIENT_PROMPT);
  meta("clinical-patient-fact-ids-v3", PATIENT_PROMPT_V3);
  meta("doctor_max_output_tokens", String(doctorTokenLimit));
  meta(
    "doctor_request_sampling",
    JSON.stringify(
      Object.fromEntries(models.map((m) => [m, doctorSampling(m)])),
    ),
  );
  meta(
    "doctor_temperature_policy",
    "Target 1.0. Kimi sends 1 explicitly. For GPT and Claude the temperature field is omitted to use the API default. No effective sampling temperature is returned.",
  );
  meta("patient_and_judge_max_output_tokens", String(cfg.maxTokens));
  meta(
    "design",
    "Three independent interviews per distinct case and doctor model. Select the historical patient prompt from the main analysis first, then the main study, then the latest attempt. Only link interviews with matching historical prompts. Invalid outputs count as attempts and are recorded.",
  );
  const rows = db
    .prepare(
      `select a.case_id,a.case_attempt_id,a.fact_pack_sha256,a.case_presentation,a.reference_diagnosis,a.accepted_alternatives_json,r.prompt_version,count(*) n from case_attempts a join sessions s using(session_id) join interview_rounds r using(case_attempt_id) group by a.case_attempt_id,r.prompt_version order by a.case_id,s.included_in_main_analysis desc,(s.session_type='main') desc,a.completed_at_unix desc,a.case_attempt_id`,
    )
    .all();
  assert.equal(
    rows.length,
    db.prepare("select count(*) n from case_attempts").get().n,
  );
  const checkedAssets = new Set();
  const selectedPrompts = new Map();
  for (const a of rows) {
    if (!selectedPrompts.has(a.case_id))
      selectedPrompts.set(a.case_id, a.prompt_version);
    if (selectedPrompts.get(a.case_id) !== a.prompt_version) continue;
    const c = cases.get(a.case_id);
    assert(c);
    assert.equal(c.opening, a.case_presentation);
    assert.equal(c.reference_diagnosis, a.reference_diagnosis);
    assert.deepEqual(
      c.accepted_alternatives || [],
      JSON.parse(a.accepted_alternatives_json),
    );
    // PostgreSQL JSONB can reorder lab keys. Restore the fact order and IDs seen by the original patient.
    const imageIds = patientRecord(c).imageIds;
    c.fact_pack = db
      .prepare(
        "select fact_id as id,status,fact_text as text from case_facts where case_attempt_id=? order by rowid",
      )
      .all(a.case_attempt_id)
      .filter((f) => !imageIds.has(f.id));
    assert.equal(patientRecord(c).sha256, a.fact_pack_sha256);
    assert.equal(a.n, 3);
    assert(usesPatientFactIds(a.prompt_version));
    for (const image of c.media || [])
      if (!checkedAssets.has(image.asset_id)) {
        asset(image.asset_id);
        checkedAssets.add(image.asset_id);
      }
    for (const model of models) {
      for (const replicate of replicates) {
        db.prepare(
          "insert or ignore into llm_runs(case_id,patient_prompt_version,doctor_model,replicate,doctor_reasoning_effort,temperature_target,temperature_sent,fact_pack_sha256) values(?,?,?,?,'max',1,?,?)",
        ).run(
          c.id,
          a.prompt_version,
          model,
          replicate,
          doctorSampling(model).temperature ?? null,
          a.fact_pack_sha256,
        );
        const matching = db
          .prepare(
            "select run_id,fact_pack_sha256 from llm_runs where case_id=? and patient_prompt_version=? and doctor_model=? and replicate=?",
          )
          .get(c.id, a.prompt_version, model, replicate);
        assert.equal(matching.fact_pack_sha256, a.fact_pack_sha256);
        db.prepare("insert or ignore into llm_case_links values(?,?)").run(
          matching.run_id,
          a.case_attempt_id,
        );
      }
    }
  }
  db.exec("commit");
} catch (e) {
  db.exec("rollback");
  throw e;
}
const support = new OpenRouter(cfg);
const doctors = new Map(
  models.map((model) => [
    model,
    new OpenRouter(
      { ...cfg, maxTokens: doctorTokenLimit, llmTimeout: mode === "repair" ? 900000 : 300000 },
      fetch,
      [model],
      doctorSampling(model),
    ),
  ]),
);
const badConfig = new Set();
let accountError = null;
const picked = new Set();
const counts = db.prepare(
  "select doctor_model,status,count(*) n from llm_runs group by doctor_model,status order by doctor_model,status",
);
console.log(JSON.stringify(counts.all()));
async function doRun(r) {
  let sequence = 0,
    question,
    round = 0;
  let role = "doctor";
  const remember = db.prepare("insert into llm_calls values(?,?,?,?,?,?,?,?)");
  const provider = {
    complete: async (model, messages, json) => {
      const i = sequence++;
      role = i === 7 ? "judge" : i % 2 ? "patient" : "doctor";
      const sampling = role === "doctor" ? doctorSampling(model) : {};
      const h = sha(
        JSON.stringify([
          model,
          messages,
          !!json,
          sampling,
          role === "doctor" ? doctorTokenLimit : cfg.maxTokens,
        ]),
      );
      const old = db
        .prepare(
          "select request_sha256,response_json from llm_calls where run_id=? and sequence=?",
        )
        .get(r.run_id, i);
      if (old) {
        assert.equal(
          old.request_sha256,
          h,
          "Cannot resume with different request",
        );
        return JSON.parse(old.response_json);
      }
      const adapter = role === "doctor" ? doctors.get(model) : support;
      const start = seconds();
      let reply;
      for (let attempt = 0; ; attempt++) {
        try {
          reply = await adapter.complete(model, messages, json);
          break;
        } catch (e) {
          if (
            !/^openrouter_(?:http_(?:429|500|502|503|504)|response_error)$/.test(
              e.message,
            ) ||
            attempt >= 4
          )
            throw e;
          db.prepare(
            "insert or ignore into llm_provider_errors values(?,?,?)",
          ).run(r.run_id, seconds(), role + ": " + e.message);
          await pause(2 ** attempt * 2000 + Math.random() * 1000);
        }
      }
      remember.run(
        r.run_id,
        i,
        role,
        model,
        h,
        JSON.stringify({ ...reply, request_sampling: sampling }),
        start,
        seconds(),
      );
      return reply;
    },
  };
  try {
    const c = cases.get(r.case_id);
    const result = await runSimulation(
      media,
      c,
      r.doctor_model,
      provider,
      async (who, reply) => {
        if (who === "doctor") {
          if (round < 3) {
            const s = reply.content
              .trim()
              .replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gi, "");
            question = JSON.parse(s).question;
          }
        } else {
          const p = JSON.parse(reply.content);
          db.prepare(
            "insert or ignore into llm_rounds values(?,?,?,?,?,?)",
          ).run(
            r.run_id,
            ++round,
            question,
            p.answer,
            JSON.stringify(p.metadata.patient_fact_ids),
            JSON.stringify(p.metadata.released_image_ids),
          );
        }
      },
      async () => {},
      r.patient_prompt_version,
    );
    assert.equal(round, 3);
    const { diagnosis, confidence } = result.diagnoses[0];
    db.prepare(
      "update llm_runs set diagnosis=?, confidence=?,confidence_scale=? where run_id=?",
    ).run(diagnosis, confidence, result.confidence_scale, r.run_id);
    const verdict = await judgeDiagnoses(
      provider,
      {
        predictions: result.diagnoses,
        ground_truth: c.reference_diagnosis,
        accepted_alternatives: c.accepted_alternatives || [],
        confidence_scale: result.confidence_scale,
      },
      async () => {},
    );
    db.prepare(
      "update llm_runs set status='completed',judge_verdict=?,error=null,finished_at_unix=? where run_id=?",
    ).run(verdict.diagnoses[0].verdict, seconds(), r.run_id);
  } catch (e) {
    const problem =
      e instanceof ProviderError
        ? e.message
        : e instanceof SyntaxError
          ? "invalid_json"
          : e.name === "ZodError"
            ? "invalid_structured_output"
            : e.message;
    const status = problem.startsWith("openrouter_")
      ? "provider_error"
      : role === "judge"
        ? "judge_error"
        : "invalid_output";
    db.prepare(
      "update llm_runs set status=?,error=?,finished_at_unix=? where run_id=?",
    ).run(status, role + ": " + problem, seconds(), r.run_id);
    console.warn(
      JSON.stringify({ run: r.run_id, model: r.doctor_model, role, problem }),
    );
    if (["openrouter_http_401", "openrouter_http_402"].includes(problem))
      accountError = problem;
    // Keep an individual forbidden request as a terminal failure. Other case requests
    // may still be served by this model, so do not disable their queue for a 403.
    if (/^openrouter_http_(400|404)$/.test(problem)) {
      if (role === "doctor") badConfig.add(r.doctor_model);
      else accountError = problem;
    }
  }
}
async function worker() {
  while (!accountError) {
    const pending = db
      .prepare("select * from llm_runs where status='queued' order by run_id")
      .all();
    const row = pending.find(
      (r) =>
        !badConfig.has(r.doctor_model) &&
        (mode !== "pilot" || !picked.has(r.doctor_model)),
    );
    if (!row) return;
    const changed = db
      .prepare(
        "update llm_runs set status='running',started_at_unix=coalesce(started_at_unix,?) where run_id=? and status='queued'",
      )
      .run(seconds(), row.run_id);
    if (!changed.changes) continue;
    picked.add(row.doctor_model);
    await doRun(row);
  }
}
try {
  if (mode === "repair") {
    db.exec("begin immediate");
    try {
      // A cached successful call (including the diagnosis) is never repeated.
      // Only a returned provider failure can be retried; preserve every original error.
      const failures = db
        .prepare(
          "select run_id,error,finished_at_unix from llm_runs where status='provider_error'",
        )
        .all();
      for (const failed of failures) {
        if (
          !/openrouter_(?:response_error|timeout|network_or_response_error|http_429|http_50[0234])$/.test(
            failed.error,
          )
        )
          continue;
        db.prepare(
          "insert or ignore into llm_provider_errors values(?,?,?)",
        ).run(failed.run_id, failed.finished_at_unix, failed.error);
        db.prepare(
          "update llm_runs set status='queued' where run_id=? and status='provider_error'",
        ).run(failed.run_id);
      }
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  }
  if (mode !== "verify") {
    await Promise.all(
      Array.from({ length: mode === "pilot" ? 3 : concurrency }, worker),
    );
  }
  if (mode === "verify") {
    const caseCount = db
      .prepare("select count(distinct case_id) as n from case_attempts")
      .get().n;
    assert.equal(
      db.prepare("select count(*) as n from llm_runs").get().n,
      caseCount * models.length * replicates.length,
    );
    assert.equal(
      db
        .prepare(
          `select count(*) n from (
      select case_id,doctor_model from llm_runs group by 1,2 having count(distinct replicate)<>3
    )`,
        )
        .get().n,
      0,
    );
    assert.equal(
      db
        .prepare(
          `select count(*) n from llm_runs r where
      not exists(select 1 from llm_case_links l where l.run_id=r.run_id) or
      started_at_unix is null or finished_at_unix is null or
      (status<>'completed' and error is null) or
      doctor_reasoning_effort<>'max' or temperature_target<>1 or
      temperature_sent is not (case when doctor_model='moonshotai/kimi-k3.1-pro' then 1 end)`,
        )
        .get().n,
      0,
    );
    assert.equal(
      db
        .prepare(
          `select count(*) n from llm_calls c join llm_runs r using(run_id)
      where json_extract(response_json,'$.returned_model') is not model or
      (role='doctor' and (model<>doctor_model or json_extract(response_json,'$.request_sampling.reasoning.effort') is not 'max'
        or json_extract(response_json,'$.request_sampling.temperature') is not temperature_sent))
      or (role<>'doctor' and json_extract(response_json,'$.request_sampling') is not '{}')`,
        )
        .get().n,
      0,
    );
    assert.equal(
      db
        .prepare(
          `select count(*) n from (
      select json_extract(response_json,'$.generation_id') as generation_id from llm_calls
      group by 1 having generation_id is null or count(*)>1)`,
        )
        .get().n,
      0,
      "Missing or reused provider generation ID",
    );
    assert.equal(
      db
        .prepare(
          "select count(*) n from llm_runs where status in ('running','queued')",
        )
        .get().n,
      0,
      "Some interviews are still pending",
    );
    for (const row of db
      .prepare("select distinct image_id from llm_response_images")
      .all()) {
      const image = asset(row.image_id);
      db.prepare("insert or ignore into llm_image_assets values(?,?,?)").run(
        image.id,
        image.mime_type,
        Buffer.from(image.data_base64, "base64"),
      );
    }
    assert.equal(
      db
        .prepare(
          "select count(*) n from llm_runs r where status='completed' and (diagnosis is null or confidence is null or confidence not between 1 and 7 or judge_verdict is null or judge_verdict not in ('correct','incorrect') or (select count(*) from llm_rounds x where x.run_id=r.run_id)<>3 or (select count(*) from llm_calls x where x.run_id=r.run_id)<>8)",
        )
        .get().n,
      0,
    );
    assert.equal(
      db
        .prepare(
          "select count(*) n from llm_runs r join llm_case_links l using(run_id) join llm_rounds x using(run_id),json_each(x.fact_ids_json) j where not exists(select 1 from case_facts f where f.case_attempt_id=l.case_attempt_id and f.fact_id=j.value)",
        )
        .get().n,
      0,
    );
    assert.equal(
      db.prepare("select count(*) n from llm_rounds").get().n,
      db.prepare("select count(*) n from llm_round_results").get().n,
    );
    assert.equal(
      db.prepare("pragma integrity_check").get().integrity_check,
      "ok",
    );
    assert.deepEqual(db.prepare("pragma foreign_key_check").all(), []);
  }
  console.log(JSON.stringify(counts.all()));
  if (accountError || badConfig.size) process.exitCode = 2;
} finally {
  db.exec("pragma wal_checkpoint(truncate)");
  db.close();
}
