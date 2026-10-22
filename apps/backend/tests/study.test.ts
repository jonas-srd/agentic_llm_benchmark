import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { Database, one } from "../src/lib/db.js";
import { migrate } from "../src/lib/migrations.js";
import { settingsFromEnv } from "../src/lib/config.js";
import { createApp } from "../src/app.js";
import { demoConfig } from "../src/routes/studies.js";
import { claimJob, processTurn, processRun } from "../src/domain/jobs.js";
import {
  ProviderError,
  type Provider,
  type Message,
} from "../src/lib/openrouter.js";
import { StudySchema, MODEL_IDS } from "@clinical/shared";
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
      const r = await req("/v1/preview/sessions", { consent: true });
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
      assert.equal(
        (
          await step({
            physician: true,
            specialty: "Internal medicine",
            years: 5,
          })
        ).status,
        200,
      );
      assert.equal((await step()).status, 200);
      return session;
    };
    const base = () => `/v1/sessions/${session.id}/cases/${session.step.id}`;
    const ask = async (target = "patient", tests: string[] = []) => {
      const r = await req(`${base()}/questions`, {
        request_id: randomUUID(),
        revision: session.revision,
        target,
        question: target === "patient" ? "When did this start?" : "",
        tests,
      });
      if (r.status === 202) session = r.data.session;
      return r;
    };
    const diagnosis = async () => {
      const r = await req(`${base()}/diagnosis`, {
        request_id: randomUUID(),
        revision: session.revision,
        diagnosis: "Test diagnosis",
        confidence: 80,
      });
      if (r.status === 200) session = r.data;
      return r;
    };
    const calls: { model: string; messages: Message[] }[] = [];
    const provider: Provider = {
      complete: async (model, messages) => {
        calls.push({ model, messages });
        return {
          content: "Known patient evidence.",
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
  test(`${mode}: migrations are repeatable and preserve existing sessions`, async (t) => {
    const f = await fixture(t);
    await f.enroll();
    await migrate(f.db);
    assert.equal((await f.req(`/v1/sessions/${f.session.id}`)).status, 200);
  });
  test(`${mode}: original images require an owned, completed lab order`, async (t) => {
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
    await f.ask("lab", ["Original case images"]);
    assert.equal((await image()).status, 404);
    await f.work();
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
    await f.ask();
    await f.work();
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
    assert.equal(view.available_tests.length > 0, true);
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
    assert.equal(
      (
        await f.step({
          physician: true,
          specialty: "Internal medicine",
          years: 4,
        })
      ).status,
      200,
    );
    assert.equal(
      (await f.req(`/v1/sessions/${f.session.id}/steps/instructions`, body))
        .status,
      409,
    );
  });
  test(`${mode}: step retries are idempotent regardless of JSON key order`, async (t) => {
    const f = await fixture(t);
    await f.enroll();
    const path = `/v1/sessions/${f.session.id}/steps/screening`;
    const body = {
      request_id: randomUUID(),
      revision: 0,
      answers: { physician: true, specialty: "Surgery", years: 1 },
      include_in_analysis: null,
    };
    assert.equal((await f.req(path, body)).status, 200);
    assert.equal(
      (
        await f.req(path, {
          ...body,
          answers: { years: 1, specialty: "Surgery", physician: true },
        })
      ).status,
      200,
    );
    assert.equal(
      (await f.req(path, { ...body, answers: { ...body.answers, years: 2 } }))
        .status,
      409,
    );
  });
  test(`${mode}: early diagnosis is final and retryable`, async (t) => {
    const f = await fixture(t);
    await f.clinical();
    const path = `${f.base()}/diagnosis`;
    const body = {
      request_id: randomUUID(),
      revision: f.session.revision,
      diagnosis: "Early diagnosis",
      confidence: 70,
    };
    assert.equal((await f.req(path, body)).status, 200);
    assert.equal((await f.req(path, body)).status, 200);
    assert.equal(
      (await f.req(path, { ...body, diagnosis: "Changed" })).status,
      409,
    );
    assert.equal((await f.req(f.base())).status, 409);
  });
  test(`${mode}: patient and lab share exactly three rounds`, async (t) => {
    const f = await fixture(t);
    await f.clinical();
    const view = (await f.req(f.base())).data;
    assert.equal((await f.ask()).status, 202);
    assert.equal((await f.ask()).status, 409);
    assert.equal((await f.diagnosis()).status, 409);
    await f.work();
    assert.equal((await f.ask("lab", [view.available_tests[0]])).status, 202);
    await f.work();
    assert.equal((await f.ask()).status, 202);
    await f.work();
    assert.equal((await f.ask()).status, 409);
    assert.equal((await f.req(f.base())).data.rounds_used, 3);
    assert.equal((await f.diagnosis()).status, 200);
  });
  test(`${mode}: all roles use the session model, lab returns canonical values`, async (t) => {
    const f = await fixture(t);
    await f.clinical();
    const view = (await f.req(f.base())).data;
    await f.ask();
    await f.work();
    await f.ask("lab", [view.available_tests[0]]);
    await f.work();
    const s = (await one(f.db, "SELECT * FROM sessions WHERE id=$1", [
      f.session.id,
    ]))!;
    assert.ok(f.calls.every((c) => c.model === s.model_id));
    assert.ok(!JSON.stringify(f.calls).includes("reference_diagnosis"));
    const patient = JSON.parse(f.calls[0].messages[1].content),
      lab = JSON.parse(f.calls[1].messages[1].content);
    assert.ok(patient.patient_facts);
    assert.ok(!patient.labs);
    assert.deepEqual(Object.keys(lab.requested_results), [
      view.available_tests[0],
    ]);
    const current = (await f.req(f.base())).data;
    assert.equal(
      current.turns[1].response,
      `${view.available_tests[0]}: ${lab.requested_results[view.available_tests[0]]}`,
    );
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
      diagnosis: "Draft diagnosis",
      confidence: 65,
    };
    assert.equal((await f.req(path, body)).data.revision, 1);
    assert.equal(
      (await f.req(f.base())).data.draft.diagnosis,
      "Draft diagnosis",
    );
    assert.equal(
      (await f.req(path, { ...body, diagnosis: "Stale tab" })).status,
      409,
    );
    assert.equal(
      (await f.req(path, { ...body, revision: 1, diagnosis: "Updated" }))
        .status,
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
    for (let i = 0; i < 3; i++) assert.equal((await f.diagnosis()).status, 200);
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
  test(`${mode}: doctor, patient and lab comparison completes with one fixed model`, async (t) => {
    const f = await fixture(t);
    const config = StudySchema.parse({
      ...demoConfig(),
      id: "agent-test",
      workflow: "agent",
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
        let content = "Patient response";
        if (json) {
          doctorTurn++;
          content = JSON.stringify(
            doctorTurn === 1
              ? {
                  action: "ask_patient",
                  message: "History?",
                  tests: [],
                  diagnosis: null,
                  confidence: null,
                }
              : doctorTurn === 2
                ? {
                    action: "order_lab",
                    message: "Request tests",
                    tests: [Object.keys(config.cases[0].labs)[0]],
                    diagnosis: null,
                    confidence: null,
                  }
                : {
                    action: "diagnosis",
                    message: "Assessment",
                    tests: [],
                    diagnosis: "Agent assessment",
                    confidence: 0.8,
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
    assert.equal(run.messages.length, 5);
    assert.equal(new Set(models).size, 1);
    assert.ok(MODEL_IDS.includes(models[0] as any));
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
