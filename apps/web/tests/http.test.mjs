import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname, basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const root = resolve(import.meta.dirname, "../../..");
function surveyAnswers(step) {
  return Object.fromEntries(
    step.questions
      .filter((q) => q.required && !q.visible_when)
      .map((q) => [
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
let base, productionBase, scratch, env;
let workerDb, claimJob, processTurn;
const provider = {
  complete: async (model, messages, json) => ({
    content: JSON.stringify({
      answer: "I'm not sure.",
      fact_ids: [],
    }),
    requested_model: model,
    returned_model: model,
    provider: "test",
    generation_id: null,
    usage: {},
    latency_ms: 1,
  }),
};
async function completeRounds(request, session) {
  for (let round = 1; round <= 3; round++) {
    const early = await request(`/api/cases/${session.step.id}/diagnosis`, {
      request_id: randomUUID(),
      revision: session.revision,
      diagnoses: [{ diagnosis: "Too early", confidence: 7 }],
    });
    assert.equal(early.status, 409);
    const response = await request(`/api/cases/${session.step.id}/questions`, {
      request_id: randomUUID(),
      revision: session.revision,
      question: round === 2 ? "What do the blood tests show?" : "History?",
      tests: [],
    });
    assert.equal(response.status, 200);
    session = (await response.json()).session;
    const id = await claimJob(workerDb, "http-test", "clinical_turns");
    assert.ok(id);
    await processTurn(workerDb, provider, id, "http-test");
    const view = await (await request(`/api/cases/${session.step.id}`)).json();
    assert.equal(view.can_diagnose, round === 3);
    if (round === 2) {
      assert.equal(view.turns.at(-1).target, "patient");
      assert.equal(view.turns.at(-1).question, "What do the blood tests show?");
      assert.equal(view.turns.at(-1).response, "I'm not sure.");
    }
  }
  const extra = await request(`/api/cases/${session.step.id}/questions`, {
    request_id: randomUUID(),
    revision: session.revision,
    question: "Fourth question?",
    tests: [],
  });
  assert.equal(extra.status, 409);
  return session;
}
const children = [];
const logs = [];
async function port() {
  return new Promise((done, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const value = s.address().port;
      s.close(() => done(value));
    });
  });
}
function launch(file, overrides = {}) {
  const child = spawn(process.execPath, [file], {
    cwd: root,
    env: { ...env, ...overrides },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));
  child.on("exit", (code) => logs.push(`${file} exited: ${code}\n`));
  return child;
}
async function ready(url) {
  let last = "";
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
      last = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
    } catch (e) {
      last = String(e);
    }
    await delay(200);
  }
  throw new Error(
    `Test server did not become ready (${url}, ${last}): ` +
      logs.join("").slice(-2000),
  );
}
before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "clinical-web-test-"));
  const apiPort = await port(),
    webPort = await port();
  base = `http://127.0.0.1:${webPort}`;
  env = {
    ...process.env,
    APP_ENV: "development",
    NODE_ENV: "production",
    DATABASE_URL: `sqlite:///${join(scratch, "study.db")}`,
    ADMIN_API_KEY: randomBytes(32).toString("hex"),
    SESSION_SECRET: randomBytes(32).toString("hex"),
    OPENROUTER_API_KEY: "",
    PREVIEW_STUDY_FILE: "",
    PUBLIC_DEMO_STUDY_ID: "direct-entry-source",
    HOST: "127.0.0.1",
    HOSTNAME: "127.0.0.1",
    PORT: String(apiPort),
    BACKEND_URL: `http://127.0.0.1:${apiPort}`,
    PUBLIC_FRONTEND_URL: base,
    FRONTEND_URL: base,
    NEXT_TELEMETRY_DISABLED: "1",
  };
  const migration = launch("apps/backend/dist/apps/backend/src/migrate.js");
  await new Promise((done, reject) => {
    migration.on("exit", (code) =>
      code === 0 ? done() : reject(new Error("Migration failed")),
    );
    migration.on("error", reject);
  });
  launch("apps/backend/dist/apps/backend/src/index.js");
  await ready(env.BACKEND_URL + "/health/ready");
  const { Database } =
    await import("../../backend/dist/apps/backend/src/lib/db.js");
  workerDb = new Database(env.DATABASE_URL);
  ({ claimJob, processTurn } =
    await import("../../backend/dist/apps/backend/src/domain/jobs.js"));
  const { demoConfig } =
    await import("../../backend/dist/apps/backend/src/routes/studies.js");
  const imported = await fetch(env.BACKEND_URL + "/v1/admin/studies", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Key": env.ADMIN_API_KEY,
    },
    body: JSON.stringify({
      ...demoConfig(),
      id: env.PUBLIC_DEMO_STUDY_ID,
      is_demo: false,
    }),
  });
  assert.equal(imported.status, 201);
  await cp(
    join(root, "apps/web/.next/static"),
    join(root, "apps/web/.next/standalone/apps/web/.next/static"),
    { recursive: true },
  );
  launch("apps/web/.next/standalone/apps/web/server.js", {
    PORT: String(webPort),
  });
  await ready(base + "/api/health");
  const productionPort = await port();
  productionBase = `http://127.0.0.1:${productionPort}`;
  launch("apps/web/.next/standalone/apps/web/server.js", {
    APP_ENV: "production",
    PORT: String(productionPort),
    PUBLIC_FRONTEND_URL: productionBase,
  });
  await ready(productionBase + "/api/health");
});

async function redirectsTo(response, expected) {
  if (response.status === 307) {
    assert.equal(response.headers.get("location"), expected);
    return;
  }
  // Next.js emits a refresh meta tag if the loading boundary already streamed.
  assert.equal(response.status, 200);
  const html = await response.text();
  const meta = html.match(/<meta[^>]*id="__next-page-redirect"[^>]*>/)?.[0];
  assert.ok(
    meta,
    "Expected a server-generated redirect, not an accessible future stage",
  );
  assert.ok(meta.includes(`url=${expected}"`), `Unexpected redirect: ${meta}`);
}

test("standalone previews are local and their old public links return to the study", async () => {
  const before = (await workerDb.query("SELECT COUNT(*) AS n FROM sessions"))
    .rows[0].n;
  const response = await fetch(base + "/post-survey", {
    redirect: "manual",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  const html = await response.text();
  assert.match(html, /About you/);
  assert.match(html, /Answers entered here are not saved/);
  assert.match(html, /Specialty/);
  assert.match(html, /Continue/);
  assert.doesNotMatch(html, /__next-page-redirect/);
  const debrief = await fetch(base + "/debrief", { redirect: "manual" });
  assert.equal(debrief.status, 200);
  assert.equal(debrief.headers.get("set-cookie"), null);
  const debriefHtml = await debrief.text();
  assert.match(debriefHtml, /DEBRIEF PREVIEW/);
  assert.match(debriefHtml, /An AI system generated the replies/);
  assert.match(debriefHtml, /feuerriegel@lmu.de/);
  for (const path of ["/post-survey", "/debrief"]) {
    const res = await fetch(productionBase + path, { redirect: "manual" });
    assert.equal(res.headers.get("set-cookie"), null);
    await redirectsTo(res, "/");
  }
  assert.equal(
    (await workerDb.query("SELECT COUNT(*) AS n FROM sessions")).rows[0].n,
    before,
  );
});

test("production direct entry needs no Prolific IDs, preserves secure cookies and excludes test responses", async () => {
  let cookie = "";
  async function request(path, body) {
    return fetch(productionBase + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: productionBase,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const home = await request("/");
  assert.equal(home.status, 200);
  const homeText = await home.text();
  assert.match(homeText, /Start test session/);
  assert.doesNotMatch(homeText, /href="\/(?:post-survey|debrief)"/);
  assert.match(homeText, /physician or a doctor in training/);
  assert.match(homeText, /publication in anonymized form/);
  assert.match(homeText, /There is no time limit/);
  assert.doesNotMatch(
    homeText,
    /simulated patient|The patient is an AI simulation|No Prolific account or invitation is needed|Test session: your responses are excluded/,
  );
  for (const extra of [
    { eligibility_confirmed: false },
    { eligibility_confirmed: undefined },
    { consent: false },
  ]) {
    const rejected = await request("/api/start", {
      consent: true,
      eligibility_confirmed: true,
      consent_version: "participant-info-2026-11-03",
      ...extra,
    });
    assert.equal(rejected.status, 422);
    assert.equal(rejected.headers.get("set-cookie"), null);
  }
  const start = await request("/api/start", {
    consent: true,
    eligibility_confirmed: true,
    consent_version: "participant-info-2026-11-03",
  });
  assert.equal(start.status, 201);
  const setCookie = start.headers.get("set-cookie");
  assert.match(setCookie, /; Secure/i);
  assert.match(setCookie, /HttpOnly/i);
  cookie = setCookie.split(";")[0];
  let session = await start.json();
  assert.equal(session.is_demo, true);
  assert.equal(session.include_in_analysis, false);
  assert.ok(!("session_token" in session));
  assert.equal(session.step.id, "instructions");
  assert.equal(
    (
      await request("/api/start", {
        consent: true,
        eligibility_confirmed: true,
        consent_version: "participant-info-2026-11-03",
      })
    ).status,
    409,
  );
  while (session.status !== "completed") {
    const stageHtml = await (await request(`/study/${session.step.id}`)).text();
    assert.doesNotMatch(stageHtml, /href="\/(?:post-survey|debrief)"/);
    if (session.step.kind === "final_check") {
      assert.match(stageHtml, /The interaction was simulated/);
      assert.match(stageHtml, /An AI system generated the replies/);
    } else
      assert.doesNotMatch(
        stageHtml,
        /The interaction was simulated|An AI system generated the replies/,
      );
    const diagnosis = session.step.kind === "diagnosis";
    if (diagnosis) session = await completeRounds(request, session);
    const response = await request(
      `/api/${diagnosis ? `cases/${session.step.id}/diagnosis` : `steps/${session.step.id}`}`,
      {
        request_id: randomUUID(),
        revision: session.revision,
        ...(diagnosis
          ? {
              diagnoses: [{ diagnosis: "Test diagnosis", confidence: 7 }],
            }
          : {
              answers: session.step.id.startsWith("post-survey")
                ? surveyAnswers(session.step)
                : {},
              include_in_analysis:
                session.step.kind === "final_check" ? true : null,
            }),
      },
    );
    assert.equal(response.status, 200);
    session = await response.json();
  }
  assert.equal(session.include_in_analysis, false);
  assert.equal(session.completion_url, null);
  const practiceReceipt = await (await request("/study/outro")).text();
  assert.match(practiceReceipt, /Start a new test session/);
  assert.doesNotMatch(
    practiceReceipt,
    /Your Prolific completion code|submissions\/complete\?cc=/,
  );
  const reset = await request("/api/reset", {});
  assert.equal(reset.status, 200);
  assert.match(reset.headers.get("set-cookie"), /clinical_session=;/);
});
test("a Prolific launch after practicing gets a live receipt and never falls back to practice", async () => {
  const study = env.PUBLIC_DEMO_STUDY_ID;
  const ids = Object.fromEntries(
    ["PROLIFIC_PID", "STUDY_ID", "SESSION_ID"].map((key) => [
      key,
      randomBytes(12).toString("hex"),
    ]),
  );
  // Activate only the isolated fixture, with a known manual completion code.
  const fixture = (
    await workerDb.query("SELECT config FROM studies WHERE id=$1", [study])
  ).rows[0].config;
  await workerDb.query("UPDATE studies SET active=$1,config=$2 WHERE id=$3", [
    true,
    {
      ...fixture,
      prolific_study_id: ids.STUDY_ID,
      completion_code: "TESTRECEIPT",
    },
    study,
  ]);
  const url = "/?" + new URLSearchParams({ study, ...ids });
  let cookie = "";
  function request(path, body) {
    return fetch(productionBase + path, {
      method: body ? "POST" : "GET",
      headers: {
        Cookie: cookie,
        Origin: productionBase,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  const consent = {
    consent: true,
    eligibility_confirmed: true,
    consent_version: "participant-info-2026-11-03",
  };
  for (const partial of [
    { PROLIFIC_PID: ids.PROLIFIC_PID },
    { study },
    { ...ids },
    { study, ...ids, SESSION_ID: "" },
  ]) {
    const page = await (
      await request("/?" + new URLSearchParams(partial))
    ).text();
    assert.match(page, /Open your Prolific study link/);
    assert.doesNotMatch(page, /Start test session|Begin study/);
    assert.equal(
      (await request("/api/start", { ...consent, ...partial })).status,
      422,
    );
  }
  assert.match(
    await (await request("/study/outro")).text(),
    /Reopen your study link/,
  );
  const practice = await request("/api/start", consent);
  assert.equal(practice.status, 201);
  cookie = practice.headers.get("set-cookie").split(";")[0];
  const landing = await (await request(url)).text();
  assert.match(landing, /Begin study/);
  assert.doesNotMatch(landing, /Resume study|Start test session/);
  const live = await request("/api/start", { study, ...ids, ...consent });
  assert.equal(live.status, 201);
  cookie = live.headers.get("set-cookie").split(";")[0];
  let session = await live.json();
  assert.equal(session.is_demo, false);
  assert.match(await (await request(url)).text(), /Resume study/);
  const otherIds = { ...ids, SESSION_ID: randomBytes(12).toString("hex") };
  assert.match(
    await (
      await request("/?" + new URLSearchParams({ study, ...otherIds }))
    ).text(),
    /different participation/,
  );
  assert.equal(
    (await request("/api/start", { study, ...otherIds, ...consent })).status,
    409,
  );
  while (session.status !== "completed") {
    const step = session.step;
    assert.equal(session.completion_url, undefined);
    if (step.kind === "diagnosis")
      session = await completeRounds(request, session);
    const body =
      step.kind === "diagnosis"
        ? { diagnoses: [{ diagnosis: "Test diagnosis", confidence: 4 }] }
        : {
            answers: step.id.startsWith("post-survey")
              ? surveyAnswers(step)
              : {},
            include_in_analysis: step.kind === "final_check" ? false : null,
          };
    const result = await request(
      step.kind === "diagnosis"
        ? `/api/cases/${step.id}/diagnosis`
        : `/api/steps/${step.id}`,
      { request_id: randomUUID(), revision: session.revision, ...body },
    );
    assert.equal(result.status, 200);
    session = await result.json();
  }
  const receipt = await (await request("/study/outro")).text();
  assert.match(receipt, /<code>TESTRECEIPT<\/code>/);
  assert.match(
    receipt,
    /href="https:\/\/app\.prolific\.com\/submissions\/complete\?cc=TESTRECEIPT"/,
  );
  assert.match(await (await request(url)).text(), /View completion/);
});
after(async () => {
  await workerDb?.close();
  for (const p of children)
    if (p.exitCode === null) {
      const exited = new Promise((done) => p.once("exit", done));
      p.kill();
      await Promise.race([exited, delay(3000)]);
    }
  if (scratch) {
    const target = resolve(scratch);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("clinical-web-test-"));
    await rm(target, { recursive: true, force: true });
  }
});
test("Next.js browser API: protected cookie, routing, origin checks and mandatory rounds", async (t) => {
  let cookie = "",
    session;
  async function request(path, body, origin = base) {
    const res = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { Origin: origin }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return res;
  }
  await t.test("anonymous participants cannot read a session", async () => {
    assert.equal((await request("/api/session")).status, 401);
    const route = await request("/study/clinical-1");
    await redirectsTo(route, "/");
  });
  await t.test("cross-origin enrollment is rejected", async () => {
    assert.equal(
      (
        await request(
          "/api/start",
          {
            consent: true,
            eligibility_confirmed: true,
            consent_version: "participant-info-2026-11-03",
          },
          "https://other.example",
        )
      ).status,
      403,
    );
  });
  await t.test(
    "enrollment stores token only in HttpOnly SameSite cookie",
    async () => {
      const res = await request("/api/start", {
        consent: true,
        eligibility_confirmed: true,
        consent_version: "participant-info-2026-11-03",
      });
      assert.equal(res.status, 201);
      const setCookie = res.headers.get("set-cookie");
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=lax/i);
      cookie = setCookie.split(";")[0];
      session = await res.json();
      assert.ok(!("session_token" in session));
      assert.ok(!("model_id" in session));
    },
  );
  await t.test(
    "future-stage and home navigation resume the authoritative current step",
    async () => {
      const route = await request("/study/final");
      await redirectsTo(route, "/study/instructions");
      const home = await request("/");
      await redirectsTo(home, "/study/instructions");
      const before = await (await request("/api/session")).json();
      const preview = await request("/post-survey");
      assert.equal(preview.status, 200);
      assert.match(await preview.text(), /POST-SURVEY PREVIEW/);
      assert.deepEqual(await (await request("/api/session")).json(), before);
      await redirectsTo(
        await request("/study/post-survey"),
        "/study/instructions",
      );
    },
  );
  await t.test(
    "client cannot proxy administrator endpoints or make cross-origin mutations",
    async () => {
      assert.equal((await request("/api/admin/studies")).status, 404);
      assert.equal(
        (await request("/api/events", { events: [] }, "https://other.example"))
          .status,
        403,
      );
    },
  );
  await t.test(
    "instructions advance directly to the first patient case",
    async () => {
      for (const answers of [{}]) {
        const res = await request(`/api/steps/${session.step.id}`, {
          request_id: randomUUID(),
          revision: session.revision,
          answers,
          include_in_analysis: null,
        });
        assert.equal(res.status, 200);
        session = await res.json();
      }
      assert.equal(session.step.id, "clinical-1");
    },
  );
  await t.test(
    "case draft survives retrieval and identical retry",
    async () => {
      const body = {
        revision: 0,
        diagnosis: "",
        confidence: 75,
        question: "Test question draft",
        tests: [],
      };
      for (let i = 0; i < 2; i++) {
        const res = await request("/api/cases/clinical-1/draft", body);
        assert.equal(res.status, 200);
        assert.equal((await res.json()).revision, 1);
      }
      const view = await (await request("/api/cases/clinical-1")).json();
      assert.equal(view.draft.question, "Test question draft");
      assert.ok(!JSON.stringify(view).includes("reference_diagnosis"));
    },
  );
  await t.test(
    "three rounds, final choice and completion receipt work with a deterministic worker",
    async () => {
      for (let i = 0; i < 3; i++) {
        session = await completeRounds(request, session);
        const res = await request(`/api/cases/${session.step.id}/diagnosis`, {
          request_id: randomUUID(),
          revision: session.revision,
          diagnoses: [{ diagnosis: "Test diagnosis", confidence: 6 }],
        });
        assert.equal(res.status, 200);
        session = await res.json();
      }
      assert.equal(session.step.id, "post-survey");
      const invalidSurvey = await request("/api/steps/post-survey", {
        request_id: randomUUID(),
        revision: session.revision,
        answers: {},
        include_in_analysis: null,
      });
      assert.equal(invalidSurvey.status, 422);
      const skippedSurvey = await request("/api/steps/final", {
        request_id: randomUUID(),
        revision: session.revision,
        answers: {},
        include_in_analysis: false,
      });
      assert.equal(skippedSurvey.status, 409);
      while (session.step.id.startsWith("post-survey")) {
        const surveyResponse = await request(`/api/steps/${session.step.id}`, {
          request_id: randomUUID(),
          revision: session.revision,
          answers: surveyAnswers(session.step),
          include_in_analysis: null,
        });
        assert.equal(surveyResponse.status, 200);
        session = await surveyResponse.json();
      }
      const res = await request(`/api/steps/${session.step.id}`, {
        request_id: randomUUID(),
        revision: session.revision,
        answers: {},
        include_in_analysis: false,
      });
      assert.equal(res.status, 200);
      session = await res.json();
      assert.equal(session.status, "completed");
      assert.equal(session.include_in_analysis, false);
      const receipt = await request("/study/outro");
      assert.equal(receipt.status, 200);
      assert.match(await receipt.text(), /Thank you for taking part/);
    },
  );
});
