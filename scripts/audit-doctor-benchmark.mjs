// Offline replay only: fail on any missing recorded call; never contact a model.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  runSimulation,
  parseDoctorQuestion,
  getDoctorPrompt,
  DOCTOR_PROMPT_QUESTION_WORDS,
  MAX_DOCTOR_QUESTION_WORDS,
} from "../apps/backend/src/domain/agents.ts";
import {
  patientRecord,
  selectPatientFacts,
  planFactAblation,
} from "../apps/backend/src/domain/facts.ts";
import { judgeDiagnoses } from "../apps/backend/src/domain/judge.ts";
const [input, reportPath] = process.argv.slice(2);
assert(input, "Supply the current benchmark database to audit offline");
const db = new DatabaseSync(input, { readOnly: true });
const meta = Object.fromEntries(
  db
    .prepare("select * from llm_metadata")
    .all()
    .map((x) => [x.key, x.value]),
);
const {
  version: PROMPT_VERSION,
  systemPrompt: DOCTOR,
  turnInstructions: DOCTOR_TURN_INSTRUCTIONS,
} = getDoctorPrompt(meta.doctor_prompt_version);
assert.equal(meta[PROMPT_VERSION], DOCTOR);
assert.deepEqual(
  JSON.parse(meta.doctor_turn_instructions),
  DOCTOR_TURN_INSTRUCTIONS,
);
assert.equal(
  Number(meta.doctor_prompt_question_words),
  DOCTOR_PROMPT_QUESTION_WORDS,
);
assert.equal(
  Number(meta.doctor_question_hard_cap_words),
  MAX_DOCTOR_QUESTION_WORDS,
);
const pool = new Map(
  JSON.parse(readFileSync("data/clinical-300/study.json", "utf8")).cases.map(
    (c) => [c.id, c],
  ),
);
const sha = (x) => createHash("sha256").update(x).digest("hex");
const sampling = JSON.parse(meta.doctor_request_sampling);
let runs = 0,
  calls = 0,
  truncated = 0,
  betweenPromptAndCap = 0;
const media = {
  query: async (sql, [id]) => {
    assert.equal(
      sql,
      "SELECT mime_type,data_base64 FROM case_media WHERE id=$1",
    );
    const asset = db
      .prepare(
        "select mime_type,image_data from llm_image_assets where image_id=?",
      )
      .get(id);
    assert(asset, "Missing released image");
    assert.equal(sha(asset.image_data), id);
    return {
      rows: [
        {
          mime_type: asset.mime_type,
          data_base64: Buffer.from(asset.image_data).toString("base64"),
        },
      ],
      rowCount: 1,
    };
  },
};
for (const r of db
  .prepare("select * from llm_runs where status='completed' order by run_id")
  .all()) {
  assert.equal(r.doctor_prompt_version, PROMPT_VERSION);
  assert.equal(r.doctor_prompt_question_words, DOCTOR_PROMPT_QUESTION_WORDS);
  assert.equal(r.doctor_max_question_words, MAX_DOCTOR_QUESTION_WORDS);
  const c = structuredClone(pool.get(r.case_id));
  const a = db
    .prepare(
      "select a.* from llm_case_links l join case_attempts a using(case_attempt_id) where run_id=? limit 1",
    )
    .get(r.run_id);
  assert.equal(c.opening, a.case_presentation);
  const imageIds = patientRecord(c).imageIds;
  c.fact_pack = db
    .prepare(
      "select fact_id as id,status,fact_text as text from case_facts where case_attempt_id=? order by rowid",
    )
    .all(a.case_attempt_id)
    .filter((f) => !imageIds.has(f.id));
  const fullRecord = patientRecord(c);
  assert.equal(
    fullRecord.sha256,
    r.original_fact_pack_sha256 ?? r.fact_pack_sha256,
  );
  let retainedIds;
  let effectiveRecord = fullRecord;
  if (r.condition_id) {
    const condition = db
      .prepare("select * from llm_conditions where condition_id=?")
      .get(r.condition_id);
    const factSet = db
      .prepare(
        "select * from llm_case_fact_sets where condition_id=? and case_id=?",
      )
      .get(r.condition_id, r.case_id);
    assert.equal(factSet.original_sha256, fullRecord.sha256);
    if (condition.removal_percent) {
      const plan = planFactAblation(
        fullRecord,
        c.id,
        condition.seed,
        condition.removal_percent,
      );
      retainedIds = JSON.parse(factSet.retained_fact_ids_json);
      assert.deepEqual(retainedIds, plan.retainedIds);
      assert.deepEqual(
        JSON.parse(factSet.removed_fact_ids_json),
        plan.removedIds,
      );
      effectiveRecord = selectPatientFacts(fullRecord, retainedIds);
    }
    assert.equal(effectiveRecord.sha256, factSet.effective_sha256);
  }
  assert.equal(effectiveRecord.sha256, r.fact_pack_sha256);
  let sequence = 0,
    round = 0,
    question;
  const provider = {
    complete: async (model, messages, json) => {
      const i = sequence++;
      const row = db
        .prepare("select * from llm_calls where run_id=? and sequence=?")
        .get(r.run_id, i);
      assert(row, "Missing call; offline replay cannot call a provider");
      const doctor = i < 7 && i % 2 === 0;
      const params = doctor ? sampling[model] : {};
      const maxTokens = Number(
        meta[
          doctor
            ? "doctor_max_output_tokens"
            : "patient_and_judge_max_output_tokens"
        ],
      );
      assert.equal(
        sha(JSON.stringify([model, messages, !!json, params, maxTokens])),
        row.request_sha256,
        `Request mismatch for ${r.run_id}/${i}`,
      );
      assert.equal(model, row.model);
      if (doctor) {
        assert.deepEqual(Object.keys(messages[0]).sort(), ["content", "role"]);
        assert.equal(messages[0].content, DOCTOR);
        assert.equal(
          messages[1].content,
          JSON.stringify({ case: a.case_presentation }),
        );
        assert.equal(messages.at(-1).content, DOCTOR_TURN_INSTRUCTIONS[i / 2]);
      } else if (i < 7) {
        assert(
          messages[0].content.endsWith(
            "\n" + JSON.stringify(effectiveRecord.facts),
          ),
          "Patient must receive exactly the retained facts",
        );
      }
      calls++;
      return JSON.parse(row.response_json);
    },
  };
  const result = await runSimulation(
    media,
    c,
    r.doctor_model,
    provider,
    async (role, reply) => {
      if (role === "doctor" && round < 3) {
        question = parseDoctorQuestion(reply.content);
        const raw = reply.content
          .trim()
          .replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
        const count = JSON.parse(raw).question.trim().split(/\s+/u).length;
        if (count > MAX_DOCTOR_QUESTION_WORDS) truncated++;
        else if (count > DOCTOR_PROMPT_QUESTION_WORDS) betweenPromptAndCap++;
      } else if (role === "patient") {
        const stored = db
          .prepare("select * from llm_rounds where run_id=? and round_number=?")
          .get(r.run_id, ++round);
        const patient = JSON.parse(reply.content);
        assert.equal(patient.metadata.fact_pack_sha256, effectiveRecord.sha256);
        assert.equal(stored.doctor_question, question);
        assert.equal(stored.patient_answer, patient.answer);
        assert.deepEqual(
          JSON.parse(stored.fact_ids_json),
          patient.metadata.patient_fact_ids,
        );
        assert.deepEqual(
          JSON.parse(stored.released_image_ids_json),
          patient.metadata.released_image_ids,
        );
      }
    },
    async () => {},
    r.patient_prompt_version,
    retainedIds,
    PROMPT_VERSION,
  );
  assert.equal(result.diagnoses[0].diagnosis, r.diagnosis);
  assert.equal(result.diagnoses[0].confidence, r.confidence);
  const judged = await judgeDiagnoses(
    provider,
    {
      predictions: result.diagnoses,
      ground_truth: c.reference_diagnosis,
      accepted_alternatives: c.accepted_alternatives || [],
      confidence_scale: result.confidence_scale,
    },
    async () => {},
  );
  assert.equal(judged.diagnoses[0].verdict, r.judge_verdict);
  assert.equal(sequence, 8);
  assert.equal(round, 3);
  runs++;
}
const report = {
  verified_at: new Date().toISOString(),
  doctor_prompt_version: PROMPT_VERSION,
  condition_id: meta.condition_id ?? "complete_facts",
  prompt_question_words: DOCTOR_PROMPT_QUESTION_WORDS,
  hard_cap_words: MAX_DOCTOR_QUESTION_WORDS,
  completed_interviews_replayed: runs,
  request_hashes_verified: calls,
  truncated_questions: truncated,
  questions_above_prompt_limit_within_hard_cap: betweenPromptAndCap,
  external_api_calls: 0,
};
if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
db.close();
