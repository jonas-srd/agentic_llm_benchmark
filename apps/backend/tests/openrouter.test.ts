import test from "node:test";
import assert from "node:assert/strict";
import { OpenRouter } from "../src/lib/openrouter.js";
import { settingsFromEnv } from "../src/lib/config.js";
import { MODEL_IDS } from "@clinical/shared";
const settings = settingsFromEnv({
  ADMIN_API_KEY: "a".repeat(40),
  SESSION_SECRET: "s".repeat(40),
  OPENROUTER_API_KEY: "test",
});
test("OpenRouter pins the model, disables fallback and requests JSON only for doctor", async () => {
  let payload: any;
  const provider = new OpenRouter(settings, (async (_url, options) => {
    payload = JSON.parse(options!.body as string);
    return Response.json({
      model: MODEL_IDS[0],
      choices: [{ finish_reason: "stop", message: { content: "{}" } }],
    });
  }) as typeof fetch);
  await provider.complete(
    MODEL_IDS[0],
    [{ role: "user", content: "Case" }],
    true,
  );
  assert.equal(payload.model, MODEL_IDS[0]);
  assert.deepEqual(payload.provider, {
    allow_fallbacks: false,
    require_parameters: true,
  });
  assert.equal(payload.response_format.type, "json_object");
});
test("OpenRouter rejects changed models and incomplete output", async () => {
  for (const data of [
    {
      model: MODEL_IDS[1],
      choices: [{ finish_reason: "stop", message: { content: "Answer" } }],
    },
    {
      model: MODEL_IDS[0],
      choices: [{ finish_reason: "length", message: { content: "Partial" } }],
    },
  ]) {
    const p = new OpenRouter(settings, (async () =>
      Response.json(data)) as typeof fetch);
    await assert.rejects(
      p.complete(MODEL_IDS[0], []),
      /unexpected_model|incomplete_completion/,
    );
  }
});
test("OpenRouter never retries or returns raw error content", async () => {
  let calls = 0;
  const p = new OpenRouter(settings, (async () => {
    calls++;
    return new Response("secret provider details", { status: 429 });
  }) as typeof fetch);
  await assert.rejects(p.complete(MODEL_IDS[0], []), {
    message: "openrouter_http_429",
  });
  assert.equal(calls, 1);
  await assert.rejects(p.complete("not-allowed", []), /model_not_allowed/);
  assert.equal(calls, 1);
});
