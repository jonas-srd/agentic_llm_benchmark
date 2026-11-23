import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { runSimulation, getDoctorPrompt, parseDoctorQuestion } from "../apps/backend/src/domain/agents.ts";
import { patientRecord } from "../apps/backend/src/domain/facts.ts";
import { PATIENT_PROMPT } from "../apps/backend/src/domain/patient.ts";
import { judgeDiagnoses, JUDGE_PROMPT, JUDGE_PROMPT_VERSION } from "../apps/backend/src/domain/judge.ts";
import { SUPPORT_MODEL } from "../apps/backend/src/domain/protocol.ts";
import { OpenRouter, ProviderError } from "../apps/backend/src/lib/openrouter.ts";
import { settingsFromEnv } from "../apps/backend/src/lib/config.ts";

const [path, mode = "run", reportPath] = process.argv.slice(2);
assert(path && ["preflight", "run", "verify"].includes(mode));
const db = new DatabaseSync(path);
db.exec("pragma foreign_keys=on; pragma journal_mode=WAL; pragma busy_timeout=20000;");
const operation = "nejm119_gpt_v8_repeat_20261120";
const rows = db.prepare("select r.* from llm_runs r join llm_repeat_targets t using(run_id) where t.operation_id=? order by r.replicate").all(operation);
assert.deepEqual(rows.map(r => r.replicate), [1, 2, 3]);
const meta = Object.fromEntries(db.prepare("select key,value from llm_benchmark_metadata where batch_id='prompt10_cap15_v8'").all().map(x => [x.key, x.value]));
const prompt = getDoctorPrompt("doctor-patient-top1-three-rounds-prompt10-truncate15-v8");
assert.equal(meta.doctor_prompt_version, prompt.version);
assert.equal(meta[prompt.version], prompt.systemPrompt);
assert.deepEqual(JSON.parse(meta.doctor_turn_instructions), prompt.turnInstructions);
assert.equal(meta["clinical-patient-fact-ids-v4"], PATIENT_PROMPT);
assert.equal(meta[JUDGE_PROMPT_VERSION], JUDGE_PROMPT);
assert.equal(meta.patient_model, SUPPORT_MODEL);
assert.equal(meta.judge_model, SUPPORT_MODEL);
const sampling = JSON.parse(meta.doctor_request_sampling)["openai/gpt-6.1-sol"];
assert.deepEqual(sampling, { reasoning: { effort: "max" } });
const doctorTokens = Number(meta.doctor_max_output_tokens);
const supportTokens = Number(meta.patient_and_judge_max_output_tokens);
assert.equal(doctorTokens, 32768);
assert.equal(supportTokens, 1800);
const sha = data => createHash("sha256").update(data).digest("hex");
const now = () => Date.now() / 1000;
const pool = JSON.parse(readFileSync("data/clinical-300/study.json", "utf8"));
const spec = structuredClone(pool.cases.find(c => c.id === "nejm-119"));
assert(spec);
const originalImageIds = patientRecord(spec).imageIds;
const firstCase = db.prepare("select a.* from case_attempts a join llm_case_links l using(case_attempt_id) where l.run_id=? limit 1").get(rows[0].run_id);
assert.equal(spec.opening, firstCase.case_presentation);
assert.equal(spec.reference_diagnosis, firstCase.reference_diagnosis);
assert.deepEqual(spec.accepted_alternatives || [], JSON.parse(firstCase.accepted_alternatives_json));
spec.fact_pack = db.prepare("select fact_id id,status,fact_text text from case_facts where case_attempt_id=? order by rowid").all(firstCase.case_attempt_id).filter(f => !originalImageIds.has(f.id));
const fullRecord = patientRecord(spec);
for (const r of rows) {
  assert.equal(r.case_id, spec.id);
  assert.equal(r.doctor_model, "openai/gpt-6.1-sol");
  assert.equal(r.doctor_prompt_version, prompt.version);
  assert.equal(r.patient_prompt_version, "clinical-patient-fact-ids-v4");
  assert.equal(r.condition_id, "complete_facts");
  assert.equal(r.fact_pack_sha256, fullRecord.sha256);
  assert.equal(r.original_fact_pack_sha256, fullRecord.sha256);
  assert.equal(r.doctor_prompt_question_words, 10);
  assert.equal(r.doctor_max_question_words, 15);
  assert.equal(r.temperature_sent, null);
  assert.equal(r.doctor_reasoning_effort, "max");
}
const media = { query: async (sql, [id]) => {
  assert.equal(sql, "SELECT mime_type,data_base64 FROM case_media WHERE id=$1");
  assert(spec.media.some(m => m.asset_id === id));
  assert.match(id, /^[0-9a-f]{64}$/);
  const a = JSON.parse(readFileSync(`data/clinical-300/media/${id}.json`, "utf8"));
  const bytes = Buffer.from(a.data_base64, "base64");
  assert.equal(sha(bytes), id);
  db.prepare("insert or ignore into llm_image_assets values(?,?,?)").run(id, a.mime_type, bytes);
  return { rows: [a], rowCount: 1 };
}};
const requestHash = (sequence, model, messages, json) => sha(JSON.stringify([model, messages, !!json, sequence < 7 && sequence % 2 === 0 ? sampling : {}, sequence < 7 && sequence % 2 === 0 ? doctorTokens : supportTokens]));

// Verify every recorded call before the original 403 without contacting any model.
const endOfArchive = Symbol("end-of-archive");
let archivedCallsVerified = 0;
for (const r of rows) {
  const snapshot = db.prepare("select calls_json from llm_previous_run_attempts where operation_id=? and run_id=?").get(operation, r.run_id);
  const calls = JSON.parse(snapshot.calls_json);
  let sequence = 0;
  const replay = { complete: async (model, messages, json) => {
    const old = calls.find(x => x.sequence === sequence);
    if (!old) throw endOfArchive;
    assert.equal(requestHash(sequence++, model, messages, json), old.request_sha256);
    archivedCallsVerified++;
    return JSON.parse(old.response_json);
  }};
  try {
    await runSimulation(media, spec, r.doctor_model, replay, async () => {}, async () => {}, r.patient_prompt_version, undefined, prompt.version);
    assert.fail("The original interrupted interview unexpectedly completed");
  } catch (e) { if (e !== endOfArchive) throw e; }
  assert.equal(sequence, calls.length);
}
console.log(JSON.stringify({ preflight: "passed", archived_request_hashes_verified: archivedCallsVerified, prompt_version: prompt.version, fresh_interviews: true }));

async function execute(r) {
  if (r.status !== "queued") return;
  assert.equal(db.prepare("select count(*) n from llm_calls where run_id=?").get(r.run_id).n, 0);
  assert.equal(db.prepare("update llm_runs set status='running',started_at_unix=? where run_id=? and status='queued'").run(now(), r.run_id).changes, 1);
  const cfg = settingsFromEnv();
  const doctor = new OpenRouter({ ...cfg, maxTokens: doctorTokens, llmTimeout: 900000 }, fetch, [r.doctor_model], sampling);
  const support = new OpenRouter({ ...cfg, maxTokens: supportTokens }, fetch, [SUPPORT_MODEL]);
  let sequence = 0, round = 0, role = "doctor", question;
  const provider = { complete: async (model, messages, json) => {
    const i = sequence++;
    role = i === 7 ? "judge" : i % 2 ? "patient" : "doctor";
    const hash = requestHash(i, model, messages, json);
    const adapter = role === "doctor" ? doctor : support;
    const start = now();
    let reply;
    for (let attempt = 0; ; attempt++) {
      try { reply = await adapter.complete(model, messages, json); break; }
      catch (e) {
        if (!/^openrouter_(?:http_(?:429|500|502|503|504)|response_error)$/.test(e.message) || attempt >= 4) throw e;
        db.prepare("insert or ignore into llm_provider_errors values(?,?,?)").run(r.run_id, now(), role + ": " + e.message);
        await new Promise(resolve => setTimeout(resolve, 2 ** attempt * 2000 + Math.random() * 1000));
      }
    }
    db.prepare("insert into llm_calls values(?,?,?,?,?,?,?,?)").run(r.run_id, i, role, model, hash, JSON.stringify({ ...reply, request_sampling: role === "doctor" ? sampling : {} }), start, now());
    return reply;
  }};
  try {
    const result = await runSimulation(media, spec, r.doctor_model, provider, async (who, reply, version) => {
      if (who === "doctor") {
        assert.equal(version, prompt.version);
        if (round < 3) question = parseDoctorQuestion(reply.content);
      } else {
        const p = JSON.parse(reply.content);
        assert.equal(p.metadata.fact_pack_sha256, fullRecord.sha256);
        db.prepare("insert into llm_rounds values(?,?,?,?,?,?)").run(r.run_id, ++round, question, p.answer, JSON.stringify(p.metadata.patient_fact_ids), JSON.stringify(p.metadata.released_image_ids));
      }
    }, async () => {}, r.patient_prompt_version, undefined, prompt.version);
    assert.equal(round, 3);
    const { diagnosis, confidence } = result.diagnoses[0];
    db.prepare("update llm_runs set diagnosis=?,confidence=?,confidence_scale=? where run_id=?").run(diagnosis, confidence, result.confidence_scale, r.run_id);
    const verdict = await judgeDiagnoses(provider, { predictions: result.diagnoses, ground_truth: spec.reference_diagnosis, accepted_alternatives: spec.accepted_alternatives || [], confidence_scale: result.confidence_scale }, async () => {});
    assert.equal(sequence, 8);
    db.prepare("update llm_runs set status='completed',error=null,judge_verdict=?,finished_at_unix=? where run_id=?").run(verdict.diagnoses[0].verdict, now(), r.run_id);
  } catch (e) {
    const problem = e instanceof ProviderError ? e.message : e instanceof SyntaxError ? "invalid_json" : e.name === "ZodError" ? "invalid_structured_output" : e.message;
    const status = problem.startsWith("openrouter_") ? "provider_error" : role === "judge" ? "judge_error" : "invalid_output";
    db.prepare("update llm_runs set status=?,error=?,finished_at_unix=? where run_id=?").run(status, role + ": " + problem, now(), r.run_id);
    console.warn(JSON.stringify({ run_id: r.run_id, replicate: r.replicate, role, problem }));
  }
  console.log(JSON.stringify(db.prepare("select run_id,replicate,status,error from llm_runs where run_id=?").get(r.run_id)));
}
try {
  if (mode === "verify") {
    let currentRequestsVerified = 0;
    for (const r of rows) {
      assert(!["queued", "running"].includes(r.status));
      const calls = db.prepare("select * from llm_calls where run_id=? order by sequence").all(r.run_id);
      let sequence = 0;
      const replay = { complete: async (model, messages, json) => {
        const old = calls.find(x => x.sequence === sequence);
        if (!old) throw endOfArchive;
        assert.equal(requestHash(sequence++, model, messages, json), old.request_sha256);
        currentRequestsVerified++;
        return JSON.parse(old.response_json);
      }};
      try {
        const result = await runSimulation(media, spec, r.doctor_model, replay, async () => {}, async () => {}, r.patient_prompt_version, undefined, prompt.version);
        assert.equal(result.diagnoses[0].diagnosis, r.diagnosis);
        assert.equal(result.diagnoses[0].confidence, r.confidence);
        const judgment = await judgeDiagnoses(replay, { predictions: result.diagnoses, ground_truth: spec.reference_diagnosis, accepted_alternatives: spec.accepted_alternatives || [], confidence_scale: result.confidence_scale }, async () => {});
        assert.equal(r.status, "completed");
        assert.equal(judgment.diagnoses[0].verdict, r.judge_verdict);
      } catch (e) {
        if (e !== endOfArchive || r.status !== "provider_error") throw e;
      }
      assert.equal(sequence, calls.length);
    }
    const report = { verified_at: new Date().toISOString(), operation_id: operation, prompt_version: prompt.version, condition_id: "complete_facts", original_request_hashes_verified: archivedCallsVerified, new_request_hashes_verified: currentRequestsVerified, statuses: rows.map(r => ({ run_id: r.run_id, replicate: r.replicate, status: r.status, error: r.error })), external_api_calls: 0 };
    if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
  if (mode === "run") {
    db.prepare("update llm_repeat_operations set status='running' where operation_id=?").run(operation);
    await Promise.all(rows.map(execute));
    const pending = db.prepare("select count(*) n from llm_runs r join llm_repeat_targets t using(run_id) where t.operation_id=? and r.status in ('queued','running')").get(operation).n;
    assert.equal(pending, 0);
    db.prepare("update llm_repeat_operations set status='finished' where operation_id=?").run(operation);
  }
} finally { db.exec("pragma wal_checkpoint(truncate)"); db.close(); }
