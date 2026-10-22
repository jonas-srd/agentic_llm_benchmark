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
let base, scratch, env;
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
      last = `HTTP ${res.status}: ${(await res.text()).slice(0,200)}`;
    } catch (e) { last = String(e); }
    await delay(200);
  }
  throw new Error(
    `Test server did not become ready (${url}, ${last}): ` + logs.join("").slice(-2000),
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
  await cp(
    join(root, "apps/web/.next/static"),
    join(root, "apps/web/.next/standalone/apps/web/.next/static"),
    { recursive: true },
  );
  launch("apps/web/.next/standalone/apps/web/server.js", {
    PORT: String(webPort),
  });
  await ready(base + "/api/health");
});
after(async () => {
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
test("Next.js browser API: protected cookie, routing, origin checks and full early-diagnosis flow", async (t) => {
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
    assert.ok(
      meta.includes(`url=${expected}"`),
      `Unexpected redirect: ${meta}`,
    );
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
          { consent: true, consent_version: "1" },
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
        consent_version: "1",
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
      await redirectsTo(route, "/study/screening");
      const home = await request("/");
      await redirectsTo(home, "/study/screening");
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
  await t.test("background and instructions advance through Hono", async () => {
    for (const answers of [
      { physician: true, specialty: "Internal medicine", years: 5 },
      {},
    ]) {
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
  });
  await t.test(
    "case draft survives retrieval and identical retry",
    async () => {
      const body = {
        revision: 0,
        diagnosis: "Test draft",
        confidence: 75,
        question: "",
        tests: [],
      };
      for (let i = 0; i < 2; i++) {
        const res = await request("/api/cases/clinical-1/draft", body);
        assert.equal(res.status, 200);
        assert.equal((await res.json()).revision, 1);
      }
      const view = await (await request("/api/cases/clinical-1")).json();
      assert.equal(view.draft.diagnosis, "Test draft");
      assert.ok(!JSON.stringify(view).includes("reference_diagnosis"));
    },
  );
  await t.test(
    "early diagnoses, final choice and completion receipt work without LLM calls",
    async () => {
      for (let i = 0; i < 3; i++) {
        const res = await request(`/api/cases/${session.step.id}/diagnosis`, {
          request_id: randomUUID(),
          revision: session.revision,
          diagnosis: "Test diagnosis",
          confidence: 75,
        });
        assert.equal(res.status, 200);
        session = await res.json();
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
