import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { Database, one, insert } from "../src/lib/db.js";
import { migrate } from "../src/lib/migrations.js";
import { settingsFromEnv } from "../src/lib/config.js";
import { createApp } from "../src/app.js";
import { demoConfig } from "../src/routes/studies.js";
import {
  claimJob,
  processTurn,
  processRun,
  processJudgment,
} from "../src/domain/jobs.js";
import {
  ProviderError,
  type Provider,
  type Message,
} from "../src/lib/openrouter.js";
import {
  StudySchema,
  MODEL_IDS,
  emptyDiagnoses,
  POST_SURVEY_STEP,
  POST_SURVEY_STEPS,
  LEGACY_POST_SURVEY_STEP,
  LEGACY_POST_SURVEY_VERSION,
  isPostSurvey,
  POST_SURVEY_VERSION,
} from "@clinical/shared";
function surveyAnswers(step: any = POST_SURVEY_STEP) {
  return Object.fromEntries(
    step.questions
      .filter((q: any) => q.required && !q.visible_when)
      .map((q: any) => [
        q.id,
        q.kind === "choice"
          ? q.options[0]
          : q.kind === "likert"
            ? 4
            : q.kind === "number"
              ? 0
              : q.kind === "boolean"
                ? false
                : "Test",
      ]),
  );
}
import { patientRecord } from "../src/domain/facts.js";
const settings = settingsFromEnv({
  ADMIN_API_KEY: "a".repeat(40),
  SESSION_SECRET: "s".repeat(40),
  OPENROUTER_API_KEY: "test-key",
});
const modes = [
  "sqlite",
  ...(process.env.TEST_DATABASE_URL ? ["postgres"] : []),
];
for (const mode of modes) {
  async function fixture(t: any) {
    let admin: Database | undefined;
    let schema = "";
    let url = ":memory:";
    if (mode === "postgres") {
      admin = new Database(process.env.TEST_DATABASE_URL!);
      schema = `test_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`CREATE SCHEMA ${schema}`);
      const u = new URL(process.env.TEST_DATABASE_URL!);
      u.searchParams.set("options", `-c search_path=${schema}`);
      url = u.toString();
    }
    const db = new Database(url);
    await migrate(db);
    const app = createApp(db, settings, () => "127.0.0.1");
    t.after(async () => {
      await db.close();
      if (admin) {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.close();
      }
    });
    let session: any;
    let token = "";
    const req = async (
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) => {
      const r = await app.request(path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, data: (await r.json()) as any };
    };
    const enroll = async () => {
      const r = await req("/v1/preview/sessions", {
        consent: true,
        eligibility_confirmed: true,
        consent_version: demoConfig().consent_version,
      });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      session = r.data;
      token = session.session_token;
      return session;
    };
    const step = async (
      answers: unknown = {},
      include: boolean | null = null,
    ) => {
      const body = {
        request_id: randomUUID(),
        revision: session.revision,
        answers,
        include_in_analysis: include,
      };
      const r = await req(
        `/v1/sessions/${session.id}/steps/${session.step.id}`,
        body,
      );
      if (r.status === 200) session = r.data;
      return r;
    };
    const clinical = async () => {
      await enroll();
      assert.equal((await step()).status, 200);
      return session;
    };
    const base = () => `/v1/sessions/${session.id}/cases/${session.step.id}`;
    const ask = async (
      target = "patient",
      tests: string[] = [],
      question?: string,
    ) => {
      const r = await req(`${base()}/questions`, {
        request_id: randomUUID(),
        revision: session.revision,
        target,
        question:
          question ?? (target === "patient" ? "When did this start?" : ""),
        tests,
      });
      if (r.status === 202) session = r.data.session;
      return r;
    };
    const diagnosis = async () => {
      const r = await req(`${base()}/diagnosis`, {
        request_id: randomUUID(),
        revision: session.revision,
        diagnoses: [{ diagnosis: "Test diagnosis", confidence: 6 }],
      });
      if (r.status === 200) session = r.data;
      return r;
    };
    const calls: { model: string; messages: Message[] }[] = [];
    const provider: Provider = {
      complete: async (model, messages) => {
        calls.push({ model, messages });
        return {
          content: JSON.stringify({
            answer: "I'm not sure.",
            fact_ids: [],
          }),
          requested_model: model,
          returned_model: model,
          provider: "test",
          generation_id: "test-generation",
          usage: { total_tokens: 10 },
          latency_ms: 1,
        };
      },
    };
    const work = async (p = provider) => {
      const id = await claimJob(db, "worker", "clinical_turns");
      assert.ok(id);
      await processTurn(db, p, id, "worker");
      return id;
    };
    const completeRounds = async () => {
      while ((await req(base())).data.rounds_completed < 3) {
        assert.equal((await ask()).status, 202);
        await work();
      }
    };
    return {
      db,
      app,
      req,
      enroll,
      step,
      clinical,
      base,
      ask,
      diagnosis,
      work,
      completeRounds,
      calls,
      provider,
      get session() {
        return session;
      },
      get token() {
        return token;
      },
    };
  }
  test(`${mode}: enrollment requires eligibility, research consent and the current information version`, async (t) => {
    const f = await fixture(t);
    const info = (await f.req("/v1/preview")).data;
    const body = {
      consent: true,
      eligibility_confirmed: true,
      consent_version: info.consent_version,
    };
    for (const invalid of [
      { ...body, consent: false },
      { ...body, eligibility_confirmed: false },
      { consent: true, consent_version: info.consent_version },
      { consent: true, eligibility_confirmed: true },
    ])
      assert.equal((await f.req("/v1/preview/sessions", invalid)).status, 422);
    assert.equal(
      (await f.req("/v1/preview/sessions", { ...body, consent_version: "old" }))
        .status,
      409,
    );
    assert.equal((await f.db.query("SELECT id FROM sessions")).rows.length, 0);
    await f.enroll();
    assert.equal(f.session.step.id, "instructions");
    const saved = (await one(
      f.db,
      "SELECT snapshot FROM sessions WHERE id=$1",
      [f.session.id],
    ))!;
    assert.equal(saved.snapshot.consent_version, info.consent_version);
    assert.equal(saved.snapshot.consent_text, info.consent_text);
    assert.ok(
      saved.snapshot.consent_text.includes("publication in anonymized form"),
    );
    const enrolled = (await one(
      f.db,
      "SELECT data FROM study_events WHERE session_id=$1 AND event_type='enrolled'",
      [f.session.id],
    ))!;
    assert.equal(enrolled.data.eligibility_confirmed, true);
    assert.equal(
      enrolled.data.research_and_anonymized_publication_consent,
      true,
    );
    assert.equal(enrolled.data.consent_version, info.consent_version);
  });
  test(`${mode}: migrations are repeatable and preserve existing sessions`, async (t) => {
    const f = await fixture(t);
    await f.enroll();
    await migrate(f.db);
    assert.equal((await f.req(`/v1/sessions/${f.session.id}`)).status, 200);
  });
  test(`${mode}: the additive migration preserves completed legacy diagnoses and three-round exports`, async (t) => {
    const f = await fixture(t);
    await f.clinical();
    for (let round = 0; round < 3; round++) {
      await f.ask();
      await f.work();
    }
    await f.db.query(
      "UPDATE clinical_cases SET diagnosis='Historical answer',confidence=65,confidence_scale='percent_0_100',completed_at=1 WHERE session_id=$1 AND step_id=$2",
      [f.session.id, f.session.step.id],
    );
    await f.db.query("ALTER TABLE clinical_cases DROP COLUMN diagnoses_json");
    await f.db.query("DELETE FROM app_migrations WHERE version=$1", [
      "003_ranked_diagnoses",
    ]);
    await migrate(f.db);
    await migrate(f.db);
    const exported = (
      await f.req("/v1/admin/studies/clinician-demo-v2/export", undefined, {
        "X-Admin-Key": settings.adminKey,
      })
    ).data.sessions[0].clinical_cases[0];
    assert.equal(exported.diagnosis, "Historical answer");
    assert.equal(exported.confidence, 65);
    assert.equal(exported.diagnoses, null);
    assert.equal(exported.protocol_version, "legacy-single-diagnosis");
    assert.equal(exported.max_rounds, 3);
    assert.equal(exported.round_timing.length, 3);
    assert.equal(exported.can_ask, false);
  });
  test(`${mode}: Likert migration preserves historical answers and upgrades only unfinished work`, async (t) => {
    const f = await fixture(t);
    await f.clinical();
    const activeId = f.session.id;
    const previous = (await one(f.db, "SELECT * FROM sessions WHERE id=$1", [
      activeId,
    ]))!;
    previous.snapshot.steps = previous.snapshot.steps.filter(
      (step: any) => !isPostSurvey(step.id),
    );
    previous.snapshot.clinical_protocol_version = "patient-only-top3-v2";
    delete previous.snapshot.post_survey_version;
    const oldDiagnoses = [
      { diagnosis: "Historical", probability: 80 },
      { diagnosis: "Alternative", probability: 20 },
      { diagnosis: "", probability: 0 },
    ];
    const oldDraft = {
      question: "Saved question",
      diagnoses: [
        { diagnosis: "Unfinished diagnosis", probability: 65 },
        { diagnosis: "", probability: 0 },
        { diagnosis: "", probability: 0 },
      ],
    };
    await f.db.query(
      "UPDATE sessions SET snapshot=$1,step_index=2 WHERE id=$2",
      [previous.snapshot, activeId],
    );
    await f.db.query(
      "UPDATE clinical_cases SET diagnosis='Historical',confidence=80,diagnoses_json=$1,completed_at=1 WHERE session_id=$2 AND step_id='clinical-1'",
      [oldDiagnoses, activeId],
    );
    await f.db.query(
      "INSERT INTO task_drafts(session_id,step_id,data,revision,updated_at) VALUES($1,'clinical-2',$2,1,1)",
      [activeId, oldDraft],
    );
    await f.enroll();
    const completedId = f.session.id;
    await f.db.query(
      "UPDATE sessions SET status='completed',snapshot=$1,step_index=$2 WHERE id=$3",
      [previous.snapshot, previous.snapshot.steps.length, completedId],
    );
    await f.db.query("ALTER TABLE clinical_cases DROP COLUMN confidence_scale");
    await f.db.query("DELETE FROM app_migrations WHERE version=$1", [
      "005_confidence_post_survey",
    ]);
    await migrate(f.db);
    await migrate(f.db);
    const active = (await one(f.db, "SELECT * FROM sessions WHERE id=$1", [
      activeId,
    ]))!;
    assert.equal(active.snapshot.steps[active.step_index].id, "clinical-2");
    assert.equal(active.revision, previous.revision + 1);
    assert.equal(active.snapshot.steps.at(-2).id, "post-survey");
    assert.equal(
      active.snapshot.steps.filter((s: any) => s.id === "post-survey").length,
      1,
    );
    const closed = (await one(
      f.db,
      "SELECT * FROM clinical_cases WHERE session_id=$1 AND step_id='clinical-1'",
      [activeId],
    ))!;
    assert.deepEqual(closed.diagnoses_json, oldDiagnoses);
    assert.equal(closed.confidence, 80);
    assert.equal(closed.confidence_scale, "percent_0_100");
    const draft = (await one(
      f.db,
      "SELECT * FROM task_drafts WHERE session_id=$1 AND step_id='clinical-2'",
      [activeId],
    ))!;
    assert.equal(draft.data.diagnoses[0].diagnosis, "Unfinished diagnosis");
    assert.deepEqual(
      draft.data.diagnoses.map((d: any) => d.confidence),
      [4, 4, 4],
    );
    assert.equal(draft.revision, 2);
    const preserved = (await one(
      f.db,
      "SELECT data FROM study_events WHERE session_id=$1 AND event_type='legacy_diagnosis_draft_preserved'",
      [activeId],
    ))!;
    assert.deepEqual(preserved.data, oldDraft);
    const completed = (await one(f.db, "SELECT * FROM sessions WHERE id=$1", [
      completedId,
    ]))!;
    assert.deepEqual(completed.snapshot, previous.snapshot);
    assert.equal(completed.status, "completed");
  });
  test(`${mode}: top-one migration retains the first draft rating and preserves historical top-three answers`, async (t) => {
    const f = await fixture(t);
    await f.clinical();
    const id = f.session.id;
    const original = (await one(f.db, "SELECT * FROM sessions WHERE id=$1", [
      id,
    ]))!;
    original.snapshot.clinical_protocol_version = "patient-only-top3-likert-v3";
    const ranked = [
      { diagnosis: "A", confidence: 6 },
      { diagnosis: "B", confidence: 4 },
      { diagnosis: "", confidence: null },
    ];
    const oldDraft = { question: "Saved question", diagnoses: ranked };
    await f.db.query(
      "UPDATE sessions SET snapshot=$1,step_index=2 WHERE id=$2",
      [original.snapshot, id],
    );
    await f.db.query(
      "UPDATE clinical_cases SET diagnosis='A',confidence=6,diagnoses_json=$1,completed_at=1 WHERE session_id=$2 AND step_id='clinical-1'",
      [ranked, id],
    );
    await f.db.query(
      "INSERT INTO task_drafts(session_id,step_id,data,revision,updated_at) VALUES($1,'clinical-2',$2,1,1)",
      [id, oldDraft],
    );
    await f.enroll();
    const completedId = f.session.id;
    await f.db.query(
      "UPDATE sessions SET status='completed',snapshot=$1,step_index=$2 WHERE id=$3",
      [original.snapshot, original.snapshot.steps.length, completedId],
    );
    await f.db.query("DELETE FROM app_migrations WHERE version=$1", [
      "006_single_diagnosis",
    ]);
    await migrate(f.db);
    await migrate(f.db);
    const active = (await one(f.db, "SELECT * FROM sessions WHERE id=$1", [
      id,
    ]))!;
    assert.equal(
      active.snapshot.clinical_protocol_version,
      "patient-only-top1-likert-v4",
    );
    assert.equal(active.snapshot.steps[active.step_index].id, "clinical-2");
    assert.equal(active.revision, original.revision + 1);
    const draft = (await one(
      f.db,
      "SELECT * FROM task_drafts WHERE session_id=$1 AND step_id='clinical-2'",
      [id],
    ))!;
    assert.deepEqual(draft.data.diagnoses, [ranked[0]]);
    assert.equal(draft.data.question, "Saved question");
    assert.equal(draft.revision, 2);
    const archived = (await one(
      f.db,
      "SELECT data FROM study_events WHERE session_id=$1 AND event_type='ranked_diagnosis_draft_preserved'",
      [id],
    ))!;
    assert.deepEqual(archived.data, oldDraft);
    const completed = (await one(f.db, "SELECT * FROM sessions WHERE id=$1", [
      completedId,
    ]))!;
    assert.deepEqual(completed.snapshot, original.snapshot);
    const exported = (
      await f.req("/v1/admin/studies/clinician-demo-v2/export", undefined, {
        "X-Admin-Key": settings.adminKey,
      })
    ).data.sessions.find((s: any) => s.id === id);
    assert.deepEqual(exported.clinical_cases[0].diagnoses, ranked);
    assert.equal(
      exported.clinical_cases[0].protocol_version,
      "patient-only-top3-likert-v3",
    );
    assert.equal(
      exported.clinical_cases[1].protocol_version,
      "patient-only-top1-three-rounds-v5",
    );
  });
  test(`${mode}: three-round migration preserves completed cases and lets an older pending fourth answer finish`, async (t) => {
    const f = await fixture(t);
    await f.clinical();
    await f.completeRounds();
    const first = (await f.req(f.base())).data;
    const template = (await one(
      f.db,
      "SELECT * FROM clinical_turns WHERE case_attempt_id=$1 LIMIT 1",
      [first.id],
    ))!;
    for (const round of [4, 5])
      await insert(f.db, "clinical_turns", {
        ...template,
        id: randomUUID(),
        request_id: randomUUID(),
        round_number: round,
      });
    await f.db.query("UPDATE clinical_cases SET rounds_used=5 WHERE id=$1", [
      first.id,
    ]);
    assert.equal((await f.diagnosis()).status, 200);
    const historicalEvent = (await one(
      f.db,
      "SELECT * FROM study_events WHERE session_id=$1 AND event_type='diagnosis_submitted'",
      [f.session.id],
    ))!;
    const historicalData = {
      ...historicalEvent.data,
      protocol_version: "patient-only-top1-likert-v4",
    };
    delete historicalData.max_rounds;
    await f.db.query("UPDATE study_events SET data=$1 WHERE id=$2", [
      historicalData,
      historicalEvent.id,
    ]);
    const originalCase = await one(
      f.db,
      "SELECT * FROM clinical_cases WHERE id=$1",
      [first.id],
    );
    await f.completeRounds();
    const current = (await f.req(f.base())).data;
    await insert(f.db, "clinical_turns", {
      ...template,
      id: randomUUID(),
      request_id: randomUUID(),
      case_attempt_id: current.id,
      round_number: 4,
      status: "queued",
      response: null,
      metadata_json: null,
      worker_id: null,
      lease_until: null,
      finished_at: null,
    });
    await f.db.query("UPDATE clinical_cases SET rounds_used=4 WHERE id=$1", [
      current.id,
    ]);
    const original = (await one(f.db, "SELECT * FROM sessions WHERE id=$1", [
      f.session.id,
    ]))!;
    original.snapshot.max_question_rounds = 5;
    original.snapshot.clinical_protocol_version = "patient-only-top1-likert-v4";
    await f.db.query("UPDATE sessions SET snapshot=$1 WHERE id=$2", [
      original.snapshot,
      original.id,
    ]);
    await f.db.query("DELETE FROM app_migrations WHERE version=$1", [
      "007_three_question_rounds",
    ]);
    await migrate(f.db);
    await migrate(f.db);
    const active = (await one(f.db, "SELECT * FROM sessions WHERE id=$1", [
      original.id,
    ]))!;
    assert.equal(active.revision, original.revision + 1);
    assert.equal(active.step_index, original.step_index);
    assert.equal(active.snapshot.max_question_rounds, 3);
    assert.equal(
      active.snapshot.clinical_protocol_version,
      "patient-only-top1-three-rounds-v5",
    );
    assert.deepEqual(
      await one(f.db, "SELECT * FROM clinical_cases WHERE id=$1", [first.id]),
      originalCase,
    );
    const pending = (await f.req(f.base())).data;
    assert.equal(pending.can_ask, false);
    assert.equal(pending.can_diagnose, false);
    await f.work();
    const ready = (await f.req(f.base())).data;
    assert.equal(ready.rounds_completed, 4);
    assert.equal(ready.max_rounds, 3);
    assert.equal(ready.can_diagnose, true);
    assert.equal(ready.can_ask, false);
    assert.equal(
      (
        await f.req(f.base() + "/diagnosis", {
          request_id: randomUUID(),
          revision: active.revision,
          diagnoses: [{ diagnosis: "After transition", confidence: 6 }],
        })
      ).status,
      200,
    );
    const exported = (
      await f.req("/v1/admin/studies/clinician-demo-v2/export", undefined, {
        "X-Admin-Key": settings.adminKey,
      })
    ).data.sessions[0].clinical_cases;
    assert.equal(exported[0].max_rounds, 5);
    assert.equal(exported[0].round_timing.length, 5);
    assert.equal(exported[0].protocol_version, "patient-only-top1-likert-v4");
    assert.equal(exported[1].max_rounds, 3);
    assert.equal(exported[1].round_timing.length, 4);
    assert.equal(
      exported[1].protocol_version,
      "patient-only-top1-three-rounds-v5",
    );
  });
  test(`${mode}: original images require an owned, completed patient reply`, async (t) => {
    const f = await fixture(t);
    await f.clinical();
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=";
    const id = createHash("sha256")
      .update(Buffer.from(png, "base64"))
      .digest("hex");
    const asset = { id, mime_type: "image/png", data_base64: png };
    const admin = { "X-Admin-Key": settings.adminKey };
    assert.equal((await f.req("/v1/admin/media", asset)).status, 401);
    assert.equal(
      (await f.req("/v1/admin/media", { ...asset, id: "0".repeat(64) }, admin))
        .status,
      422,
    );
    assert.equal((await f.req("/v1/admin/media", asset, admin)).status, 201);
    const s = (await one(f.db, "SELECT * FROM sessions WHERE id=$1", [
      f.session.id,
    ]))!;
    const spec = s.snapshot.cases.find(
      (x: any) => x.id === s.snapshot.steps[s.step_index].case_id,
    );
    spec.labs["Original case images"] = "Original source figure.";
    spec.media = [
      {
        asset_id: id,
        test: "Original case images",
        caption: "Original case image",
      },
    ];
    await f.db.query("UPDATE sessions SET snapshot=$1 WHERE id=$2", [
      s.snapshot,
      s.id,
    ]);
    const url = `${f.base()}/media/${id}`;
    async function image(token = f.token) {
      return f.app.request(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    assert.equal((await image()).status, 404);
    assert.ok(!JSON.stringify((await f.req(f.base())).data).includes(id));
    await f.ask();
    await f.work();
    assert.equal((await image()).status, 404);
    await f.ask("patient", [], "Please show me the original images.");
    assert.equal((await image()).status, 404);
    await f.work({
      complete: async (model, messages) => ({
        ...(await f.provider.complete(model, messages)),
        content: JSON.stringify({
          answer: "The available original image is attached.",
          fact_ids: ["image_1"],
        }),
      }),
    });
    const view = (await f.req(f.base())).data;
    assert.equal(view.turns.at(-1).images.length, 1);
    const response = await image();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      Buffer.from(png, "base64"),
    );
    assert.equal((await image("wrong-session-token")).status, 401);
    assert.ok(!JSON.stringify(f.calls).includes(id));
    await f.completeRounds();
    assert.equal((await f.ask()).status, 409);
    assert.equal((await f.diagnosis()).status, 200);
  });
  test(`${mode}: participant reads omit secrets, model and reference diagnoses`, async (t) => {
    const f = await fixture(t);
    await f.clinical();
    const view = (await f.req(f.base())).data;
    for (const key of [
      "patient_facts",
      "reference_diagnosis",
      "model_id",
      "token_hash",
      "snapshot",
    ])
      assert.ok(!JSON.stringify(view).includes(key));
    assert.ok(!("model_id" in f.session));
    assert.equal(view.rounds_used, 0);
    assert.deepEqual(view.available_tests, []);
  });
  test(`${mode}: ownership and admin exports are protected`, async (t) => {
    const f = await fixture(t);
    await f.enroll();
    assert.equal(
      (
        await f.req(`/v1/sessions/${f.session.id}`, undefined, {
          Authorization: "Bearer wrong",
        })
      ).status,
      401,
    );
    assert.equal(
      (await f.req("/v1/admin/studies/clinician-demo-v2/export")).status,
      401,
    );
    assert.equal(
      (
        await f.req("/v1/admin/studies/clinician-demo-v2/export", undefined, {
          "X-Admin-Key": settings.adminKey,
        })
      ).status,
      200,
    );
  });
  test(`${mode}: server enforces step order, answer validation and revisions`, async (t) => {
    const f = await fixture(t);
    await f.enroll();
    const body = {
      request_id: randomUUID(),
      revision: 0,
      answers: {},
      include_in_analysis: null,
    };
    assert.equal(
      (await f.req(`/v1/sessions/${f.session.id}/steps/final`, body)).status,
      409,
    );
    assert.equal(
      (
        await f.step({
          physician: false,
          specialty: "Internal medicine",
          years: 4,
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await f.step({
          physician: true,
          specialty: "Internal medicine",
          years: -1,
        })
      ).status,
      422,
    );
    assert.equal((await f.step()).status, 200);
    assert.equal(
      (await f.req(`/v1/sessions/${f.session.id}/steps/instructions`, body))
        .status,
      409,
    );
  });
  test(`${mode}: survey migration upgrades only unreached instruments and preserves old answers`, async (t) => {
    const f = await fixture(t);
    const originals: any[] = [];
    for (const state of ["before", "entered", "completed"]) {
      await f.enroll();
      const row = (await one(f.db, "SELECT * FROM sessions WHERE id=$1", [
        f.session.id,
      ]))!;
      row.snapshot.steps = row.snapshot.steps.filter(
        (step: any) => !isPostSurvey(step.id),
      );
      row.snapshot.steps.splice(
        row.snapshot.steps.length - 1,
        0,
        LEGACY_POST_SURVEY_STEP,
      );
      row.snapshot.post_survey_version = LEGACY_POST_SURVEY_VERSION;
      const index =
        state === "before"
          ? 0
          : state === "entered"
            ? row.snapshot.steps.length - 2
            : row.snapshot.steps.length;
      await f.db.query(
        "UPDATE sessions SET snapshot=$1,step_index=$2,status=$3 WHERE id=$4",
        [
          row.snapshot,
          index,
          state === "completed" ? "completed" : "active",
          row.id,
        ],
      );
      if (state === "completed")
        await insert(f.db, "responses", {
          id: randomUUID(),
          session_id: row.id,
          step_id: "post-survey",
          request_id: randomUUID(),
          payload: { answers: surveyAnswers(LEGACY_POST_SURVEY_STEP) },
          created_at: 1,
        });
      originals.push({ ...row, state, step_index: index });
    }
    await f.db.query("DELETE FROM app_migrations WHERE version=$1", [
      "008_survey_pages_and_sources",
    ]);
    await migrate(f.db);
    const afterFirst = (await f.db.query("SELECT * FROM sessions ORDER BY id"))
      .rows;
    await migrate(f.db);
    assert.deepEqual(
      (await f.db.query("SELECT * FROM sessions ORDER BY id")).rows,
      afterFirst,
    );
    for (const original of originals) {
      const row = afterFirst.find((s) => s.id === original.id)!;
      if (original.state === "before") {
        assert.equal(row.snapshot.post_survey_version, POST_SURVEY_VERSION);
        assert.deepEqual(
          row.snapshot.steps.filter((s: any) => isPostSurvey(s.id)),
          POST_SURVEY_STEPS,
        );
        assert.equal(
          row.snapshot.steps[row.step_index].id,
          original.snapshot.steps[original.step_index].id,
        );
      } else {
        assert.deepEqual(row.snapshot, original.snapshot);
        assert.equal(row.revision, original.revision);
      }
    }
    const old = (await one(
      f.db,
      "SELECT payload FROM responses WHERE session_id=$1",
      [originals[2].id],
    ))!;
    assert.deepEqual(
      old.payload.answers,
      surveyAnswers(LEGACY_POST_SURVEY_STEP),
    );
  });
  test(`${mode}: survey retries are idempotent regardless of JSON key order`, async (t) => {
    const f = await fixture(t);
    await f.enroll();
    const saved = (await one(
      f.db,
      "SELECT snapshot FROM sessions WHERE id=$1",
      [f.session.id],
    ))!;
    const index = saved.snapshot.steps.findIndex(
      (step: any) => step.id === "post-survey",
    );
    await f.db.query("UPDATE sessions SET step_index=$1 WHERE id=$2", [
      index,
      f.session.id,
    ]);
    const path = `/v1/sessions/${f.session.id}/steps/post-survey`;
    const body = {
      request_id: randomUUID(),
      revision: 0,
      answers: surveyAnswers(),
      include_in_analysis: null,
    };
    assert.equal((await f.req(path, body)).status, 200);
    assert.equal(
      (
        await f.req(path, {
          ...body,
          answers: Object.fromEntries(Object.entries(body.answers).reverse()),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.req(path, {
          ...body,
          answers: { ...body.answers, years_in_practice: 2 },
        })
      ).status,
      409,
    );
  });
  test(`${mode}: diagnosis is locked until three responses, then final and retryable`, async (t) => {
    const f = await fixture(t);
    await f.clinical();
    const path = `${f.base()}/diagnosis`;
    assert.equal((await f.diagnosis()).status, 409);
    await f.completeRounds();
    const body = {
      request_id: randomUUID(),
      revision: f.session.revision,
      diagnoses: [
        { diagnosis: "Early diagnosis", confidence: 7 },
        ...emptyDiagnoses()
          .slice(1)
          .map((item) => ({ ...item, confidence: null })),
      ],
    };
    assert.equal((await f.req(path, body)).status, 200);
    assert.equal((await f.req(path, body)).status, 200);
    assert.equal(
      (
        await f.req(path, {
          ...body,
          diagnoses: [
            { diagnosis: "Changed", confidence: 7 },
            ...emptyDiagnoses()
              .slice(1)
              .map((item) => ({ ...item, confidence: null })),
          ],
        })
      ).status,
      409,
    );
    assert.equal((await f.req(f.base())).status, 409);
  });
  test(`${mode}: diagnosis judgment is durable, private, idempotent and independently retryable`, async (t) => {
    const f = await fixture(t);
    await f.clinical();
    await f.completeRounds();
    const originalBase = f.base();
    const body = {
      request_id: randomUUID(),
      revision: f.session.revision,
      diagnoses: [{ diagnosis: "First", confidence: 7 }],
    };
    assert.equal((await f.req(originalBase + "/diagnosis", body)).status, 200);
    assert.equal((await f.req(originalBase + "/diagnosis", body)).status, 200);
    assert.equal(
      (await f.db.query("SELECT * FROM diagnosis_judgments")).rows.length,
      1,
    );
    const id = await claimJob(f.db, "judge", "diagnosis_judgments");
    assert.ok(id);
    assert.equal(await claimJob(f.db, "other", "diagnosis_judgments"), null);
    let calls = 0;
    const judge: Provider = {
      complete: async (model, messages) => {
        const input = JSON.parse(messages[1].content);
        assert.equal(model, MODEL_IDS[0]);
        assert.equal(input["Accepted alternatives"], "none");
        return {
          ...(await f.provider.complete(model, messages)),
          content: ++calls === 1 ? "incorrect" : "correct",
        };
      },
    };
    await processJudgment(f.db, judge, id!, "wrong-owner");
    assert.equal(calls, 0);
    await processJudgment(f.db, judge, id!, "judge");
    await processJudgment(f.db, judge, id!, "judge");
    assert.equal(calls, 1);
    const stored = (await one(
      f.db,
      "SELECT * FROM diagnosis_judgments WHERE id=$1",
      [id],
    ))!;
    assert.equal(stored.status, "succeeded");
    assert.equal(stored.result.top1_correct, false);
    assert.equal(Object.hasOwn(stored.result, "top3_correct"), false);
    assert.equal(stored.result.diagnoses.length, 1);
    assert.equal(
      stored.result.diagnoses[0].metadata.requested_model,
      MODEL_IDS[0],
    );
    const current = (await f.req(`/v1/sessions/${f.session.id}`)).data;
    const currentCase = (
      await f.req(`/v1/sessions/${f.session.id}/cases/${current.step.id}`)
    ).data;
    const visible = JSON.stringify({ current, currentCase });
    for (const secret of [
      "judgment",
      "ground_truth",
      "fact_ids",
      "fact_pack",
      "accepted_alternatives",
    ])
      assert.ok(!visible.includes(secret));
    const admin = { "X-Admin-Key": settings.adminKey };
    const exported = (
      await f.req(
        "/v1/admin/studies/clinician-demo-v2/export",
        undefined,
        admin,
      )
    ).data;
    assert.deepEqual(
      exported.sessions[0].clinical_cases[0].judgment.result,
      stored.result,
    );
    const retry =
      "/v1/admin/studies/clinician-demo-v2/judgments/" + id + "/retry";
    assert.equal((await f.req(retry, {})).status, 401);
    assert.equal((await f.req(retry, {}, admin)).status, 409);
    await f.db.query(
      "UPDATE diagnosis_judgments SET status='failed',result=NULL WHERE id=$1",
      [id],
    );
    assert.equal(
      (
        await f.req(
          retry.replace("clinician-demo-v2", "wrong-study"),
          {},
          admin,
        )
      ).status,
      409,
    );
    assert.equal((await f.req(retry, {}, admin)).status, 202);
    assert.equal(await claimJob(f.db, "judge", "diagnosis_judgments"), id);
    await processJudgment(
      f.db,
      {
        complete: async (m, q) => ({
          ...(await f.provider.complete(m, q)),
          content: "incorrect because...",
        }),
      },
      id!,
      "judge",
    );
    const failed = (await one(
      f.db,
      "SELECT * FROM diagnosis_judgments WHERE id=$1",
      [id],
    ))!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.result, null);
    assert.equal(
      (
        await one(f.db, "SELECT diagnosis FROM clinical_cases WHERE id=$1", [
          stored.case_attempt_id,
        ])
      )?.diagnosis,
      "First",
    );
    assert.equal((await f.req(retry, {}, admin)).status, 202);
    await claimJob(f.db, "judge", "diagnosis_judgments");
    await processJudgment(
      f.db,
      {
        complete: async (m, q) => {
          await f.db.query(
            "UPDATE diagnosis_judgments SET lease_until=0 WHERE id=$1",
            [id],
          );
          return { ...(await f.provider.complete(m, q)), content: "correct" };
        },
      },
      id!,
      "judge",
    );
    await claimJob(f.db, "reaper", "diagnosis_judgments");
    const expired = (await one(
      f.db,
      "SELECT * FROM diagnosis_judgments WHERE id=$1",
      [id],
    ))!;
    assert.equal(expired.status, "interrupted");
    assert.equal(expired.result, null);
    assert.equal(
      (
        await one(f.db, "SELECT rounds_used FROM clinical_cases WHERE id=$1", [
          stored.case_attempt_id,
        ])
      )?.rounds_used,
      3,
    );
  });
  test(`${mode}: patient-only conversation requires exactly three successful rounds`, async (t) => {
    const f = await fixture(t);
    await f.clinical();
    assert.equal((await f.ask("lab", [], "Blood results?")).status, 422);
    assert.equal(
      (await f.ask("patient", ["CBC"], "Blood results?")).status,
      422,
    );
    for (let round = 1; round <= 3; round++) {
      assert.equal((await f.diagnosis()).status, 409);
      assert.equal(
        (await f.ask("auto", [], round % 2 ? "History?" : "Blood results?"))
          .status,
        202,
      );
      assert.equal((await f.ask()).status, 409);
      await f.work();
      const view = (await f.req(f.base())).data;
      assert.equal(view.rounds_completed, round);
      assert.equal(view.max_rounds, 3);
      assert.equal(view.can_diagnose, round === 3);
      assert.equal(view.turns.at(-1).target, "patient");
      assert.deepEqual(
        view.turns.at(-1).responses.map((r: any) => r.target),
        ["patient"],
      );
    }
    assert.equal(f.calls.length, 3);
    assert.equal((await f.ask()).status, 409);
    assert.equal((await f.diagnosis()).status, 200);
  });
  test(`${mode}: the single patient receives all evidence and context, never the reference diagnosis`, async (t) => {
    const f = await fixture(t);
    await f.clinical();
    const s = (await one(f.db, "SELECT * FROM sessions WHERE id=$1", [
      f.session.id,
    ]))!;
    const spec = s.snapshot.cases.find(
      (c: any) => c.id === s.snapshot.steps[s.step_index].case_id,
    );
    spec.patient_facts = "Pain started yesterday.";
    spec.labs = { "Blood tests": "Potassium: 4.2 mmol/L." };
    await f.db.query("UPDATE sessions SET snapshot=$1 WHERE id=$2", [
      s.snapshot,
      s.id,
    ]);
    const questions = [
      "When did it start?",
      "What are my blood results?",
      "And potassium?",
    ];
    for (let i = 0; i < questions.length; i++) {
      await f.ask("patient", [], questions[i]);
      const id = await f.work({
        complete: async (model, messages, json) => {
          assert.equal(model, MODEL_IDS[0]);
          assert.equal(json, true);
          const input = JSON.parse(messages[1].content);
          assert.ok(messages[0].content.includes(spec.patient_facts));
          assert.ok(messages[0].content.includes(spec.labs["Blood tests"]));
          assert.equal(input.previous_questions.length, i);
          assert.equal(input.question, questions[i]);
          assert.ok(
            !JSON.stringify(messages).includes(spec.reference_diagnosis),
          );
          return {
            ...(await f.provider.complete(model, messages, json)),
            content: JSON.stringify({
              answer: i
                ? "My report says potassium is 4.2 mmol/L."
                : "It started yesterday.",
              fact_ids: [
                patientRecord(spec).facts.find((fact) =>
                  fact.text.includes(
                    i ? spec.labs["Blood tests"] : spec.patient_facts,
                  ),
                )!.id,
              ],
            }),
          };
        },
      });
      const stored = (await one(
        f.db,
        "SELECT * FROM clinical_turns WHERE id=$1",
        [id],
      ))!;
      assert.equal(stored.metadata_json.patient_fact_ids.length, 1);
      assert.equal(stored.metadata_json.routing, undefined);
      assert.equal(stored.metadata_json.usage.total_tokens, 10);
    }
    assert.equal(f.calls.length, 3);
  });
  test(`${mode}: invalid fact IDs and unsupported answers refund one round without disclosure`, async (t) => {
    const f = await fixture(t);
    await f.clinical();
    for (const output of [
      { answer: "Invented result", fact_ids: ["missing_fact"] },
      { answer: "Invented history", fact_ids: [] },
      { answer: "Image", fact_ids: ["unknown_image"] },
      { answer: "Bad source", fact_ids: ["fact_0001", "fact_0001"] },
    ]) {
      await f.ask();
      await f.work({
        complete: async (model, messages) => ({
          ...(await f.provider.complete(model, messages)),
          content: JSON.stringify(output),
        }),
      });
      const view = (await f.req(f.base())).data;
      assert.equal(view.rounds_used, 0);
      assert.equal(view.turns.at(-1).status, "failed");
      assert.equal(view.turns.at(-1).response, null);
      assert.deepEqual(view.turns.at(-1).responses, []);
      assert.deepEqual(view.turns.at(-1).images, []);
    }
  });
  test(`${mode}: exactly one diagnosis and Likert confidence are required, persisted and exported`, async (t) => {
    const f = await fixture(t);
    await f.clinical();
    await f.completeRounds();
    const path = `${f.base()}/diagnosis`;
    for (const diagnoses of [
      [],
      [{ diagnosis: "A", confidence: 0 }],
      [{ diagnosis: "A", confidence: 4.5 }],
      [{ diagnosis: "A", confidence: null }],
      [
        { diagnosis: "A", confidence: 4 },
        { diagnosis: "B", confidence: 4 },
      ],
      [
        { diagnosis: "A", confidence: 8 },
        ...emptyDiagnoses()
          .slice(1)
          .map((item) => ({ ...item, confidence: null })),
      ],
      [
        { diagnosis: "A", confidence: 7 },
        { diagnosis: "B", confidence: 0 },
        { diagnosis: "", confidence: null },
      ],
      [
        { diagnosis: "A", confidence: 6 },
        { diagnosis: "", confidence: 4 },
        { diagnosis: "", confidence: null },
      ],
      [
        { diagnosis: "", confidence: null },
        { diagnosis: "B", confidence: 7 },
        { diagnosis: "", confidence: null },
      ],
    ])
      assert.equal(
        (
          await f.req(path, {
            request_id: randomUUID(),
            revision: f.session.revision,
            diagnoses,
          })
        ).status,
        422,
      );
    const diagnoses = [{ diagnosis: "A", confidence: 7 }];
    const body = {
      request_id: randomUUID(),
      revision: f.session.revision,
      diagnoses,
    };
    assert.equal((await f.req(path, body)).status, 200);
    assert.equal((await f.req(path, body)).status, 200);
    const changed = structuredClone(body);
    changed.diagnoses[0].diagnosis = "C";
    assert.equal((await f.req(path, changed)).status, 409);
    const exported = (
      await f.req(
        `/v1/admin/studies/${f.session.study_id || "clinician-demo-v2"}/export`,
        undefined,
        { "X-Admin-Key": settings.adminKey },
      )
    ).data;
    assert.deepEqual(
      exported.sessions[0].clinical_cases[0].diagnoses,
      diagnoses,
    );
    assert.equal(exported.sessions[0].clinical_cases[0].round_timing.length, 3);
    assert.equal(
      exported.sessions[0].clinical_cases[0].confidence_scale,
      "likert_1_7",
    );
    assert.equal(
      exported.sessions[0].clinical_cases[0].judgment.payload.confidence_scale,
      "likert_1_7",
    );
  });
  test(`${mode}: a lost patient lease cannot publish a reply or refund twice`, async (t) => {
    const f = await fixture(t);
    await f.clinical();
    await f.ask("auto", [], "When did it start?");
    await f.work({
      complete: async (model, messages, json) => {
        const reply = await f.provider.complete(model, messages, json);
        await f.db.query(
          "UPDATE clinical_turns SET lease_until=0 WHERE status='running'",
        );
        return {
          ...reply,
          content: JSON.stringify({
            answer: "I'm not sure.",
            fact_ids: [],
          }),
        };
      },
    });
    assert.equal(f.calls.length, 1);
    assert.equal(await claimJob(f.db, "recovery", "clinical_turns"), null);
    assert.equal(await claimJob(f.db, "recovery", "clinical_turns"), null);
    const view = (await f.req(f.base())).data;
    assert.equal(view.rounds_used, 0);
    assert.equal(view.turns[0].status, "interrupted");
  });
  test(`${mode}: failed calls refund one round and cap total attempts`, async (t) => {
    const f = await fixture(t);
    await f.clinical();
    const bad: Provider = {
      complete: async () => {
        throw new ProviderError("openrouter_timeout");
      },
    };
    for (let i = 0; i < 6; i++) {
      assert.equal((await f.ask()).status, 202);
      await f.work(bad);
    }
    const view = (await f.req(f.base())).data;
    assert.equal(view.rounds_used, 0);
    assert.equal(view.can_ask, false);
    assert.equal((await f.ask()).status, 409);
    assert.equal((await f.diagnosis()).status, 409);
    await f.db.query("UPDATE clinical_turns SET created_at=created_at-601");
    await f.completeRounds();
    assert.equal((await f.diagnosis()).status, 200);
  });
  test(`${mode}: abandoned leases are not replayed or refunded twice`, async (t) => {
    const f = await fixture(t);
    await f.clinical();
    await f.ask();
    const id = await claimJob(f.db, "gone", "clinical_turns");
    await f.db.query("UPDATE clinical_turns SET lease_until=0 WHERE id=$1", [
      id,
    ]);
    assert.equal(await claimJob(f.db, "new", "clinical_turns"), null);
    assert.equal(await claimJob(f.db, "another", "clinical_turns"), null);
    await processTurn(f.db, f.provider, id!, "gone");
    assert.equal(f.calls.length, 0);
    assert.equal((await f.req(f.base())).data.rounds_used, 0);
  });
  test(`${mode}: question retries do not create extra rounds`, async (t) => {
    const f = await fixture(t);
    await f.clinical();
    const path = `${f.base()}/questions`,
      body = {
        request_id: randomUUID(),
        revision: f.session.revision,
        target: "patient",
        question: "History?",
        tests: [],
      };
    assert.equal((await f.req(path, body)).status, 202);
    assert.equal((await f.req(path, body)).data.case.rounds_used, 1);
    assert.equal(
      (await f.req(path, { ...body, question: "Changed?" })).status,
      409,
    );
  });
  test(`${mode}: draft reload, concurrency and finalized-case guards`, async (t) => {
    const f = await fixture(t);
    await f.clinical();
    const path = `${f.base()}/draft`;
    const body = {
      revision: 0,
      question: "History?",
      tests: [],
      diagnoses: [
        { diagnosis: "Draft diagnosis", confidence: 5 },
        ...emptyDiagnoses()
          .slice(1)
          .map((item) => ({ ...item, confidence: null })),
      ],
    };
    assert.equal((await f.req(path, body)).status, 409);
    await f.completeRounds();
    assert.equal((await f.req(path, body)).data.revision, 1);
    assert.equal(
      (await f.req(f.base())).data.draft.diagnoses[0].diagnosis,
      "Draft diagnosis",
    );
    assert.equal(
      (
        await f.req(path, {
          ...body,
          diagnoses: [
            { diagnosis: "Stale tab", confidence: 5 },
            ...emptyDiagnoses()
              .slice(1)
              .map((item) => ({ ...item, confidence: null })),
          ],
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.req(path, {
          ...body,
          revision: 1,
          diagnoses: [
            { diagnosis: "Updated", confidence: 5 },
            ...emptyDiagnoses()
              .slice(1)
              .map((item) => ({ ...item, confidence: null })),
          ],
        })
      ).status,
      200,
    );
    await f.diagnosis();
    assert.equal((await f.req(path, { ...body, revision: 2 })).status, 409);
  });
  test(`${mode}: events are deduplicated and constrained to visited stages`, async (t) => {
    const f = await fixture(t);
    await f.clinical();
    const path = `/v1/sessions/${f.session.id}/events`,
      event = {
        id: randomUUID(),
        step_id: f.session.step.id,
        type: "case_enter",
        client_ts: Date.now(),
      };
    assert.equal((await f.req(path, { events: [event, event] })).status, 200);
    assert.equal(
      (await one(f.db, "SELECT COUNT(*) AS n FROM study_events WHERE id=$1", [
        event.id,
      ]))!.n,
      mode === "postgres" ? "1" : 1,
    );
    assert.equal(
      (
        await f.req(path, {
          events: [{ ...event, id: randomUUID(), step_id: "final" }],
        })
      ).status,
      422,
    );
  });
  test(`${mode}: all cases and final analysis choice required for completion`, async (t) => {
    const f = await fixture(t);
    await f.clinical();
    for (let i = 0; i < 3; i++) {
      await f.completeRounds();
      assert.equal((await f.diagnosis()).status, 200);
    }
    assert.equal((await f.step()).status, 422);
    assert.equal(f.session.step.id, "post-survey");
    for (const invalid of [
      { ...surveyAnswers(), age_group: "" },
      { ...surveyAnswers(), clinical_role: "Other" },
      { ...surveyAnswers(), years_in_practice: -1 },
      { ...surveyAnswers(), years_in_practice: 1.5 },
      { ...surveyAnswers(), years_in_practice: 81 },
      { ...surveyAnswers(), ai_familiarity: 0 },
      { ...surveyAnswers(), ai_familiarity: 8 },
      { ...surveyAnswers(), ai_familiarity: "4" },
      { ...surveyAnswers(), usability: 2.5 },
    ])
      assert.equal((await f.step(invalid)).status, 422);
    assert.equal(
      (
        await f.req(`/v1/sessions/${f.session.id}/steps/final`, {
          request_id: randomUUID(),
          revision: f.session.revision,
          answers: {},
          include_in_analysis: false,
        })
      ).status,
      409,
    );
    const answers = {
      ...surveyAnswers(),
      age_group: "Prefer not to say",
      clinical_role: "Resident physician",
      years_in_practice: 0,
    };
    assert.equal((await f.step(answers)).status, 200);
    const experience = surveyAnswers(f.session.step);
    for (const invalid of [
      { ...experience, ai_awareness: "yes" },
      { ...experience, perceived_difficulty: 7 },
      { ...experience, perceived_difficulty: 0 },
      { ...experience, case_familiarity: "4" },
      { ...experience, usability: 2.5 },
    ])
      assert.equal((await f.step(invalid)).status, 422);
    assert.equal((await f.step(experience)).status, 200);
    assert.equal(f.session.step.id, "post-survey-tools");
    for (const invalid of [
      {},
      { external_support_used: true },
      { external_support_used: true, external_support_types: [] },
      { external_support_used: true, external_support_types: ["Invented"] },
      {
        external_support_used: true,
        external_support_types: ["AI tools", "AI tools"],
      },
      { external_support_used: false, external_support_types: ["AI tools"] },
      { external_support_used: true, external_support_types: "AI tools" },
    ])
      assert.equal((await f.step(invalid)).status, 422);
    const tools = {
      external_support_used: true,
      external_support_types: ["AI tools", "Search engines"],
      feedback: "Testing",
    };
    assert.equal((await f.step(tools)).status, 200);
    assert.equal(f.session.step.kind, "final_check");
    assert.equal((await f.step()).status, 422);
    assert.equal((await f.step({}, false)).status, 200);
    assert.equal(f.session.status, "completed");
    assert.equal(f.session.include_in_analysis, false);
    assert.equal(f.session.completion_url, null);
    const exported = (
      await f.req("/v1/admin/studies/clinician-demo-v2/export", undefined, {
        "X-Admin-Key": settings.adminKey,
      })
    ).data;
    assert.ok(!JSON.stringify(exported).includes("token_hash"));
    assert.ok(JSON.stringify(exported).includes("Test diagnosis"));
    assert.equal(exported.sessions[0].post_survey.version, POST_SURVEY_VERSION);
    assert.deepEqual(
      exported.sessions[0].post_survey.response.payload.answers,
      answers,
    );
    assert.equal(
      exported.sessions[0].post_survey.questions.length,
      POST_SURVEY_STEPS.flatMap((step) => step.questions).length,
    );
    assert.equal(exported.sessions[0].post_survey.pages.length, 3);
    assert.deepEqual(exported.sessions[0].post_survey.answers, {
      ...answers,
      ...experience,
      ...tools,
    });
  });
  test(`${mode}: concurrent doctors receive all three sources without reusing any of the 150 cases`, async (t) => {
    const f = await fixture(t);
    const source = demoConfig();
    const config = StudySchema.parse({
      ...source,
      id: "exclusive-pool",
      is_demo: false,
      cases_per_participant: 5,
      cases: Array.from({ length: 150 }, (_, i) => ({
        ...source.cases[0],
        id: `case-${i}`,
        source: ["MedQA", "NEJM", "MediQ"][i % 3],
        source_id: `source-${i}`,
      })),
    });
    const admin = { "X-Admin-Key": settings.adminKey };
    assert.equal((await f.req("/v1/admin/studies", config, admin)).status, 201);
    const enroll = (i: number, study = config.id) =>
      f.req(
        `/v1/studies/${study}/sessions`,
        {
          PROLIFIC_PID: String(i).padStart(24, "0"),
          STUDY_ID: "1".repeat(24),
          SESSION_ID: String(i).padStart(24, "0"),
          consent: true,
          eligibility_confirmed: true,
          consent_version: config.consent_version,
        },
        admin,
      );
    const results = await Promise.all(
      Array.from({ length: 31 }, (_, i) => enroll(i)),
    );
    assert.equal(results.filter((r) => r.status === 201).length, 30);
    assert.equal(results.filter((r) => r.status === 409).length, 1);
    const sessions = (
      await f.db.query("SELECT * FROM sessions WHERE study_id=$1", [config.id])
    ).rows;
    assert.equal(
      new Set(
        sessions.flatMap((s) => s.snapshot.cases.map((c: any) => c.source_id)),
      ).size,
      150,
    );
    for (const s of sessions) {
      assert.equal(s.model_id, "openai/gpt-6.1-sol");
      const counts = ["MedQA", "NEJM", "MediQ"]
        .map(
          (source) =>
            s.snapshot.cases.filter((c: any) => c.source === source).length,
        )
        .sort();
      assert.deepEqual(counts, [1, 2, 2]);
    }
    assert.equal(
      (await one(f.db, "SELECT enrolled FROM studies WHERE id=$1", [
        config.id,
      ]))!.enrolled,
      30,
    );
    // A new study version must not release these source cases to another doctor.
    assert.equal(
      (
        await f.req(
          "/v1/admin/studies",
          { ...config, id: "exclusive-v2" },
          admin,
        )
      ).status,
      201,
    );
    assert.equal((await enroll(90, "exclusive-v2")).status, 409);
    await f.db.query("DELETE FROM case_allocations");
    await f.db.query("DELETE FROM app_migrations WHERE version=$1", [
      "002_exclusive_cases_timing",
    ]);
    await migrate(f.db);
    assert.equal(
      Number(
        (await one(f.db, "SELECT COUNT(*) AS n FROM case_allocations"))!.n,
      ),
      150,
    );
    assert.equal((await enroll(91, "exclusive-v2")).status, 409);
  });
  test(`${mode}: page and round timings are cumulative, owned and exported separately`, async (t) => {
    const f = await fixture(t);
    await f.clinical();
    const path = `/v1/sessions/${f.session.id}/timing`;
    const sample = {
      id: randomUUID(),
      step_id: f.session.step.id,
      phase: "page",
      round_number: 0,
      duration: { elapsed_ms: 12000, active_ms: 8000 },
    };
    assert.equal((await f.req(path, sample)).status, 200);
    assert.equal((await f.req(path, sample)).status, 200);
    assert.equal(
      (
        await f.req(path, {
          ...sample,
          duration: { elapsed_ms: 20000, active_ms: 10000 },
        })
      ).status,
      200,
    );
    assert.equal((await f.req(path, sample)).status, 200);
    assert.equal(
      (await f.req(path, { ...sample, id: randomUUID(), step_id: "final" }))
        .status,
      422,
    );
    assert.equal(
      (
        await f.req(path, {
          ...sample,
          duration: { elapsed_ms: 10, active_ms: 20 },
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await f.req(path, {
          ...sample,
          id: randomUUID(),
          phase: "round",
          round_number: 1,
        })
      ).status,
      200,
    );
    const row = (await one(f.db, "SELECT * FROM study_timings WHERE id=$1", [
      sample.id,
    ]))!;
    assert.equal(row.elapsed_ms, 20000);
    assert.equal(row.active_ms, 10000);
    const savedId = f.session.id,
      savedStep = f.session.step.id;
    await f.clinical();
    assert.equal(
      (
        await f.req(`/v1/sessions/${f.session.id}/timing`, {
          ...sample,
          step_id: f.session.step.id,
        })
      ).status,
      409,
    );
    const exported = (
      await f.req("/v1/admin/studies/clinician-demo-v2/export", undefined, {
        "X-Admin-Key": settings.adminKey,
      })
    ).data.sessions.find((s: any) => s.id === savedId);
    assert.equal(
      exported.page_timings.find((p: any) => p.step_id === savedStep)
        .elapsed_ms,
      20000,
    );
    assert.equal(
      exported.clinical_cases[0].round_timing[0].preparation.active_ms,
      8000,
    );
  });
  test(`${mode}: live Prolific enrollment checks IDs, capacity, duplicate enrollment`, async (t) => {
    const f = await fixture(t);
    const config = StudySchema.parse({
      ...demoConfig(),
      id: "live",
      is_demo: false,
      prolific_study_id: "1".repeat(24),
      completion_code: "COMPLETE",
      max_participants: 1,
    });
    const admin = { "X-Admin-Key": settings.adminKey };
    assert.equal((await f.req("/v1/admin/studies", config, admin)).status, 201);
    assert.equal(
      (await f.req("/v1/admin/studies/live/activate", {}, admin)).status,
      200,
    );
    const body = {
      PROLIFIC_PID: "2".repeat(24),
      STUDY_ID: "1".repeat(24),
      SESSION_ID: "3".repeat(24),
      consent: true,
      eligibility_confirmed: true,
      consent_version: config.consent_version,
    };
    assert.equal(
      (
        await f.req("/v1/studies/live/sessions", {
          ...body,
          STUDY_ID: "4".repeat(24),
        })
      ).status,
      422,
    );
    const enroll = await f.req("/v1/studies/live/sessions", body);
    assert.equal(enroll.status, 201);
    assert.equal((await f.req("/v1/studies/live/sessions", body)).status, 409);
    assert.equal(
      (await one(f.db, "SELECT enrolled FROM studies WHERE id='live'"))!
        .enrolled,
      1,
    );
  });
  test(`${mode}: public tests isolate enrollment and force exclusion even with a manipulated final answer`, async (t) => {
    const f = await fixture(t);
    const source = {
      ...demoConfig(),
      id: "real-pool",
      is_demo: false,
      prolific_study_id: "1".repeat(24),
      completion_code: "COMPLETE",
    };
    assert.equal(
      (
        await f.req("/v1/admin/studies", source, {
          "X-Admin-Key": settings.adminKey,
        })
      ).status,
      201,
    );
    assert.equal((await f.req("/v1/demo")).status, 404);
    const app = createApp(
      f.db,
      {
        ...settings,
        env: "production",
        publicDemoStudyId: source.id,
        publicDemoMaxSessions: 1,
      },
      () => "10.0.0.1",
    );
    let token = "";
    async function request(path: string, body?: unknown) {
      return app.request(path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    const info = (await (await request("/v1/demo")).json()) as any;
    assert.equal(info.is_demo, true);
    assert.equal(info.pool_size, source.cases.length);
    assert.ok(!JSON.stringify(info).includes("reference_diagnosis"));
    assert.equal((await request("/v1/preview")).status, 404);
    assert.equal((await request(`/v1/studies/${source.id}`)).status, 401);
    assert.equal(
      (
        await request("/v1/demo/sessions", {
          consent: false,
          consent_version: info.consent_version,
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await request("/v1/demo/sessions", {
          consent: true,
          eligibility_confirmed: true,
          consent_version: "old",
        })
      ).status,
      409,
    );
    const enrollment = {
      consent: true,
      eligibility_confirmed: true,
      consent_version: info.consent_version,
    };
    const attempts = await Promise.all([
      request("/v1/demo/sessions", enrollment),
      request("/v1/demo/sessions", enrollment),
    ]);
    assert.deepEqual(attempts.map((r) => r.status).sort(), [201, 409]);
    let session = (await attempts.find((r) => r.status === 201)!.json()) as any;
    token = session.session_token;
    assert.equal(session.include_in_analysis, false);
    assert.equal(session.step.kind, "information");
    assert.equal(session.total_cases, source.cases_per_participant);
    const original = (await one(f.db, "SELECT * FROM studies WHERE id=$1", [
      source.id,
    ]))!;
    assert.equal(!!original.active, false);
    assert.equal(original.enrolled, 0);
    while (session.status !== "completed") {
      const diagnosis = session.step.kind === "diagnosis";
      if (diagnosis)
        for (let round = 0; round < 3; round++) {
          const q = await request(
            `/v1/sessions/${session.id}/cases/${session.step.id}/questions`,
            {
              request_id: randomUUID(),
              revision: session.revision,
              target: "patient",
              question: "History?",
              tests: [],
            },
          );
          assert.equal(q.status, 202);
          session = ((await q.json()) as any).session;
          await f.work();
        }
      const result = await request(
        `/v1/sessions/${session.id}/${diagnosis ? `cases/${session.step.id}/diagnosis` : `steps/${session.step.id}`}`,
        {
          request_id: randomUUID(),
          revision: session.revision,
          ...(diagnosis
            ? {
                diagnoses: [
                  { diagnosis: "Test diagnosis", confidence: 7 },
                  ...emptyDiagnoses()
                    .slice(1)
                    .map((item) => ({ ...item, confidence: null })),
                ],
              }
            : {
                answers: isPostSurvey(session.step.id)
                  ? surveyAnswers(session.step)
                  : {},
                include_in_analysis:
                  session.step.kind === "final_check" ? true : null,
              }),
        },
      );
      assert.equal(result.status, 200);
      session = await result.json();
    }
    assert.equal(session.include_in_analysis, false);
    assert.equal(session.completion_url, null);
    const saved = (await one(f.db, "SELECT * FROM sessions WHERE id=$1", [
      session.id,
    ]))!;
    assert.notEqual(saved.study_id, source.id);
    assert.equal(!!saved.include_in_analysis, false);
    assert.equal(saved.snapshot.is_demo, true);
  });
  test(`${mode}: preview unavailable in production or on remote connections`, async (t) => {
    const f = await fixture(t);
    assert.equal(
      (
        await createApp(
          f.db,
          { ...settings, env: "production" },
          () => "127.0.0.1",
        ).request("/v1/preview")
      ).status,
      404,
    );
    assert.equal(
      (await createApp(f.db, settings, () => "10.0.0.1").request("/v1/preview"))
        .status,
      404,
    );
  });
  test(`${mode}: autonomous doctor uses patient-only dialogue, ranked diagnoses and a private judge`, async (t) => {
    const f = await fixture(t);
    const config = StudySchema.parse({
      ...demoConfig(),
      id: "agent-test",
      workflow: "agent",
      models: ["anthropic/claude-sonnet-5.5"],
      steps: [
        {
          id: "simulate",
          title: "Simulation",
          kind: "simulation",
          case_id: demoConfig().cases[0].id,
        },
        { id: "final", title: "Final", kind: "final_check" },
      ],
    });
    await f.req("/v1/admin/studies", config, {
      "X-Admin-Key": settings.adminKey,
    });
    const enrolled = (
      await f.req(
        "/v1/studies/agent-test/sessions",
        {
          PROLIFIC_PID: "2".repeat(24),
          STUDY_ID: "1".repeat(24),
          SESSION_ID: "3".repeat(24),
          consent: true,
          eligibility_confirmed: true,
          consent_version: config.consent_version,
        },
        { "X-Admin-Key": settings.adminKey },
      )
    ).data;
    const headers = { Authorization: `Bearer ${enrolled.session_token}` };
    const queued = await f.req(`/v1/sessions/${enrolled.id}/runs`, {}, headers);
    assert.equal(queued.status, 202);
    let doctorTurn = 0;
    const models: string[] = [];
    const provider: Provider = {
      complete: async (model, messages, json) => {
        models.push(model);
        if (json)
          assert.ok(
            !JSON.stringify(messages).includes(
              config.cases[0].reference_diagnosis,
            ),
          );
        let content = JSON.stringify({ fact_ids: [], answer: "I'm not sure." });
        if (model === "anthropic/claude-sonnet-5.5") {
          doctorTurn++;
          assert.ok(!JSON.stringify(messages).includes("patient_fact_ids"));
          content = JSON.stringify(
            doctorTurn <= 3
              ? {
                  question:
                    doctorTurn === 1 ? "History?" : "Please run a blood test.",
                }
              : {
                  diagnoses: [{ diagnosis: "Agent assessment", confidence: 6 }],
                },
          );
        }
        return {
          content,
          requested_model: model,
          returned_model: model,
          provider: null,
          generation_id: null,
          usage: {},
          latency_ms: 1,
        };
      },
    };
    const id = await claimJob(f.db, "worker", "runs");
    await processRun(f.db, provider, id!, "worker");
    const run = (
      await f.req(`/v1/sessions/${enrolled.id}/runs/${id}`, undefined, headers)
    ).data;
    assert.equal(run.status, "succeeded");
    assert.equal(run.messages.length, 7);
    assert.equal(run.result.diagnoses.length, 1);
    assert.equal(run.result.diagnoses[0].confidence, 6);
    assert.equal(run.result.confidence_scale, "likert_1_7");
    assert.ok(!("interviewer_model_id" in run.result));
    const persisted = await one(f.db, "SELECT result FROM runs WHERE id=$1", [id]);
    assert.equal(persisted?.result.interviewer_model_id, "anthropic/claude-sonnet-5.5");
    assert.equal(run.result.questions_used, 3);
    assert.ok(!JSON.stringify(run).includes("fact_ids"));
    assert.ok(!JSON.stringify(run).includes("ground_truth"));
    assert.equal(run.messages[1].content, "I'm not sure.");
    await f.db.query("UPDATE messages SET prompt_version=$1 WHERE run_id=$2 AND sequence=1", ["clinical-patient-fact-ids-v3", id]);
    const historical = await f.req(`/v1/sessions/${enrolled.id}/runs/${id}`, undefined, headers);
    assert.equal(historical.data.messages[1].content, "I'm not sure.");
    const judgment = await one(
      f.db,
      "SELECT * FROM diagnosis_judgments WHERE run_id=$1",
      [id],
    );
    assert.equal(judgment?.status, "queued");
    assert.equal(judgment?.payload.confidence_scale, "likert_1_7");
    assert.deepEqual(models, [
      "anthropic/claude-sonnet-5.5",
      "openai/gpt-6.1-sol",
      "anthropic/claude-sonnet-5.5",
      "openai/gpt-6.1-sol",
      "anthropic/claude-sonnet-5.5",
      "openai/gpt-6.1-sol",
      "anthropic/claude-sonnet-5.5",
    ]);
  });
  test(`${mode}: exports retain assigned order beyond nine cases`, async (t) => {
    const f = await fixture(t),
      base = demoConfig();
    const config = StudySchema.parse({
      ...base,
      id: "long-study",
      cases_per_participant: 12,
      cases: Array.from({ length: 12 }, (_, i) => ({
        ...base.cases[0],
        id: `pool-${i}`,
      })),
    });
    const admin = { "X-Admin-Key": settings.adminKey };
    assert.equal((await f.req("/v1/admin/studies", config, admin)).status, 201);
    assert.equal(
      (
        await f.req(
          "/v1/studies/long-study/sessions",
          {
            PROLIFIC_PID: "2".repeat(24),
            STUDY_ID: "1".repeat(24),
            SESSION_ID: "3".repeat(24),
            consent: true,
            eligibility_confirmed: true,
            consent_version: config.consent_version,
          },
          admin,
        )
      ).status,
      201,
    );
    const exported = (
      await f.req("/v1/admin/studies/long-study/export", undefined, admin)
    ).data;
    assert.deepEqual(
      exported.sessions[0].clinical_cases.map((c: any) => c.step_id),
      Array.from({ length: 12 }, (_, i) => `clinical-${i + 1}`),
    );
  });
}
