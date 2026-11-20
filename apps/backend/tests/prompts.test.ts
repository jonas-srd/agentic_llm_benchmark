import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CaseSchema,
  CONFIDENCE_SCALE,
  DoctorDiagnosesSchema,
  RankedDiagnosesSchema,
} from "@clinical/shared";
import { patientRecord } from "../src/domain/facts.js";
import { answerPatient, PATIENT_PROMPT } from "../src/domain/patient.js";
import { PATIENT_PROMPT_V3 } from "../src/domain/patient-prompt-v3.js";
import {
  runSimulation,
  PROMPT_VERSION,
  parseDoctorQuestion,
  DOCTOR_TURN_INSTRUCTIONS,
  DOCTOR_PROMPT_QUESTION_WORDS,
  MAX_DOCTOR_QUESTION_WORDS,
} from "../src/domain/agents.js";
import { judgeDiagnoses } from "../src/domain/judge.js";
import { Database } from "../src/lib/db.js";
import { migrate } from "../src/lib/migrations.js";
import { saveAsset } from "../src/domain/media.js";
import { releasedMedia } from "../src/domain/lab.js";
import type { Provider, Message } from "../src/lib/openrouter.js";
import { OpenRouter } from "../src/lib/openrouter.js";
import { settingsFromEnv } from "../src/lib/config.js";

const spec = CaseSchema.parse({
  id: "prompt-test",
  title: "Presentation",
  opening: "An adult with a cough.",
  patient_facts:
    "The cough started yesterday. No fever.\nNo medication history available.",
  labs: { "Blood test": "Potassium: 4.2 mmol/L. Sodium: 140 mmol/L." },
  reference_diagnosis: "HIDDEN_REFERENCE",
  accepted_alternatives: ["HIDDEN_ALTERNATIVE"],
});
const stub = (
  fn: (messages: Message[], model: string, json?: boolean) => string,
): Provider => ({
  async complete(model, messages, json) {
    return {
      content: fn(messages, model, json),
      requested_model: model,
      returned_model: model,
      provider: "test",
      generation_id: "generation",
      usage: { total_tokens: 1 },
      latency_ms: 1,
    };
  },
});

test("fact packs preserve original negatives, decimals and labels with stable IDs and no answer key", () => {
  const first = patientRecord(spec),
    second = patientRecord(spec);
  assert.deepEqual(first.facts, second.facts);
  assert.equal(first.sha256, second.sha256);
  assert.ok(first.facts.some((f) => f.text === "History: No fever."));
  assert.ok(first.facts.some((f) => f.text.includes("Potassium: 4.2 mmol/L.")));
  assert.ok(first.facts.some((f) => f.text.includes("Sodium: 140 mmol/L.")));
  assert.ok(!JSON.stringify(first.facts).includes("HIDDEN"));
  assert.ok(first.facts.every((f) => f.status === "recorded"));
  const custom = CaseSchema.parse({
    ...spec,
    fact_pack: [{ id: "no_fever", status: "absent", text: "Fever" }],
  });
  assert.deepEqual(patientRecord(custom).facts, custom.fact_pack);
  assert.equal(
    CaseSchema.safeParse({
      ...custom,
      fact_pack: [...custom.fact_pack, ...custom.fact_pack],
    }).success,
    false,
  );
});

test("patient uses supplied fact IDs, private record, exact unknown and first-question rules", async () => {
  const unknown = await answerPatient(
    stub((messages, model, json) => {
      assert.equal(model, "openai/gpt-6.1-sol");
      assert.equal(json, true);
      assert.ok(messages[0].content.includes(PATIENT_PROMPT));
      assert.ok(messages[0].content.includes("answer only the first"));
      assert.ok(messages[0].content.includes("at most two facts"));
      assert.ok(!JSON.stringify(messages).includes("HIDDEN"));
      assert.equal(
        JSON.parse(messages[1].content).previous_questions.length,
        1,
      );
      return JSON.stringify({ fact_ids: [], answer: "I'm not sure." });
    }),
    spec,
    "What is your occupation? And your blood test?",
    [{ question: "Cough?", answer: "Yes." }],
  );
  assert.equal(unknown.response, "I'm not sure.");
  assert.deepEqual(unknown.metadata.patient_fact_ids, []);
  const fact = patientRecord(spec).facts.find(
    (f) => f.text === "History: No fever.",
  )!;
  const absent = await answerPatient(
    stub(() =>
      JSON.stringify({
        fact_ids: [fact.id],
        answer: "No, I haven't had a fever.",
      }),
    ),
    spec,
    "Fever?",
    [],
  );
  assert.equal(absent.metadata.patient_facts[0].text, fact.text);
  for (const bad of [
    { fact_ids: ["invented"], answer: "No." },
    { fact_ids: [], answer: "No." },
    { fact_ids: [fact.id, fact.id], answer: "No." },
    { fact_ids: [fact.id], answer: "No.", diagnosis: "secret" },
  ])
    await assert.rejects(
      answerPatient(
        stub(() => JSON.stringify(bad)),
        spec,
        "Fever?",
        [],
      ),
    );
});

test("replays the original physician interview prompt for a historical case", async () => {
  const version = "clinical-patient-fact-ids-v3";
  const answer = await answerPatient(
    stub((messages) => {
      assert.equal(
        messages[0].content,
        PATIENT_PROMPT_V3 + "\n" + JSON.stringify(patientRecord(spec).facts),
      );
      return JSON.stringify({ fact_ids: [], answer: "I'm not sure." });
    }),
    spec,
    "Do you have siblings?",
    [],
    version,
  );
  assert.equal(answer.metadata.prompt_version, version);
});

test(
  "live patient distinguishes visible changes, partial evidence and missing facts",
  {
    skip: process.env.TEST_LIVE_PATIENT_PROMPT !== "1",
  },
  async () => {
    const provider = new OpenRouter(settingsFromEnv());
    const c = CaseSchema.parse({
      ...spec,
      fact_pack: [
        {
          id: "change",
          status: "recorded",
          text: "Physical examination: A flat pink spot on the patient's forearm gradually turned into a raised purple bump.",
        },
        {
          id: "timing",
          status: "recorded",
          text: "History: The patient started a new tablet two days before the spot appeared.",
        },
        {
          id: "skin",
          status: "recorded",
          text: "History: The patient has scalp flaking and uses a special shampoo.",
        },
        {
          id: "scan",
          status: "recorded",
          text: "Imaging: A plain X-ray of the forearm was ordered.",
        },
      ],
    });
    for (const [question, expected] of [
      ["Has the spot changed in appearance?", ["change"]],
      ["What caused the spot?", ["timing"]],
      ["Do you ever get a rash on your scalp?", ["skin"]],
      ["Is the spot painful?", []],
      ["What did the CT scan show?", []],
    ] as const) {
      const reply = await answerPatient(provider, c, question, []);
      assert.deepEqual(reply.metadata.patient_fact_ids, expected, question);
      assert.equal(
        reply.response === "I'm not sure.",
        expected.length === 0,
        question,
      );
      assert.deepEqual(reply.metadata.released_image_ids, []);
    }
  },
);

test("judge calls once per named rank including 0%, omits confidence/context and rejects malformed verdicts", async () => {
  let calls = 0,
    renewals = 0;
  const result = await judgeDiagnoses(
    stub((messages, model, json) => {
      assert.equal(model, "openai/gpt-6.1-sol");
      assert.equal(json, undefined);
      const input = JSON.parse(messages[1].content);
      assert.deepEqual(Object.keys(input), [
        "Predicted diagnosis",
        "Ground truth",
        "Accepted alternatives",
      ]);
      assert.deepEqual(input["Accepted alternatives"], ["Alias"]);
      return ++calls === 1 ? "incorrect" : "correct\n";
    }),
    {
      predictions: [
        { diagnosis: "Wrong", confidence: 100 },
        { diagnosis: "Alias", confidence: 0 },
        { diagnosis: "", confidence: 0 },
      ],
      ground_truth: "Truth",
      accepted_alternatives: ["Alias"],
    },
    async () => {
      renewals++;
    },
  );
  assert.equal(calls, 2);
  assert.equal(renewals, 2);
  assert.equal(result.top1_correct, false);
  assert.equal(result.top3_correct, true);
  assert.equal(result.diagnoses[2].verdict, null);
  assert.equal(result.diagnoses[2].status, "not_provided");
  for (const output of [
    "Correct",
    "correct because...",
    '{"verdict":"correct"}',
    "incorrect.",
    "",
  ])
    await assert.rejects(
      judgeDiagnoses(
        stub(() => output),
        {
          predictions: [{ diagnosis: "X", confidence: 100 }],
          ground_truth: "Y",
          accepted_alternatives: [],
        },
        async () => {},
      ),
      /invalid_judge_output/,
    );
});

test("LLM doctor receives the same released image and caption as a physician through the final diagnosis", async (t) => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  await migrate(db);
  const bytes = Buffer.from([255, 216, 255, 224, 0, 16]);
  const asset_id = createHash("sha256").update(bytes).digest("hex");
  const asset = {
    id: asset_id,
    mime_type: "image/jpeg",
    data_base64: bytes.toString("base64"),
  };
  await saveAsset(db, asset);
  const imageCase = CaseSchema.parse({
    ...spec,
    labs: {
      ...spec.labs,
      Scan: "Image available.",
      "Other scan": "Image available.",
    },
    media: [
      { asset_id, test: "Scan", caption: "Figure A" },
      {
        asset_id: "a".repeat(64),
        test: "Other scan",
        caption: "Unreleased image",
      },
    ],
  });
  let doctors = 0,
    patients = 0;
  const roles: string[] = [];
  const provider = stub((messages, model) => {
    assert.ok(!JSON.stringify(messages).includes("HIDDEN"));
    if (model === "anthropic/claude-sonnet-5.5") {
      doctors++;
      assert.ok(!JSON.stringify(messages).includes("fact_ids"));
      assert.ok(!JSON.stringify(messages).includes("Unreleased image"));
      const images = messages.flatMap((m) => m.images || []);
      assert.deepEqual(
        images,
        doctors <= 2
          ? []
          : [
              {
                caption: "Figure A",
                url: "data:image/jpeg;base64," + asset.data_base64,
              },
            ],
      );
      const output = JSON.stringify(
        doctors <= 3
          ? {
              question:
                doctors === 2
                  ? "May I see the scan?"
                  : "Any additional symptoms?",
            }
          : { diagnoses: [{ diagnosis: "Assessment", confidence: 7 }] },
      );
      return doctors >= 3 ? ["```json", output, "```"].join("\n") : output;
    }
    patients++;
    return patients === 2
      ? JSON.stringify({ fact_ids: ["image_1"], answer: "Here is the scan." })
      : JSON.stringify({ fact_ids: [], answer: "I'm not sure." });
  });
  const result = await runSimulation(
    db,
    imageCase,
    "anthropic/claude-sonnet-5.5",
    provider,
    async (role, reply) => {
      roles.push(role);
      if (role === "patient" && patients === 2) {
        const metadata = JSON.parse(reply.content).metadata;
        for (const version of [
          metadata.prompt_version,
          "clinical-patient-fact-ids-v3",
        ]) {
          const media = releasedMedia(imageCase, {
            question: "May I see the scan?",
            status: "succeeded",
            metadata_json: { ...metadata, prompt_version: version },
          });
          assert.deepEqual(
            media.map((m) => m.asset_id),
            [asset.id],
          );
        }
      }
    },
    async () => {},
  );
  assert.equal(doctors, 4);
  assert.equal(patients, 3);
  assert.equal(result.questions_used, 3);
  assert.equal(result.confidence_scale, CONFIDENCE_SCALE);
  assert.equal(roles.filter((r) => r === "lab").length, 0);
  await assert.rejects(
    runSimulation(
      db,
      spec,
      "anthropic/claude-sonnet-5.5",
      stub((_, model) =>
        JSON.stringify(
          model === "anthropic/claude-sonnet-5.5"
            ? { question: "More?" }
            : { fact_ids: [], answer: "I'm not sure." },
        ),
      ),
      async () => {},
      async () => {},
    ),
  );
  for (const earlyRound of [1, 2, 3]) {
    let turns = 0;
    await assert.rejects(
      runSimulation(
        db,
        spec,
        "anthropic/claude-sonnet-5.5",
        stub((_, model) =>
          JSON.stringify(
            model === "openai/gpt-6.1-sol"
              ? { fact_ids: [], answer: "I'm not sure." }
              : ++turns === earlyRound
                ? { diagnoses: [{ diagnosis: "Early", confidence: 4 }] }
                : { question: "History?" },
          ),
        ),
        async () => {},
        async () => {},
      ),
    );
    assert.equal(turns, earlyRound);
  }
});

test("doctor prompt requests 10 words while the hard cap accepts 15 and keeps the final diagnosis separate", async () => {
  assert.equal(DOCTOR_PROMPT_QUESTION_WORDS, 10);
  assert.equal(MAX_DOCTOR_QUESTION_WORDS, 15);
  const db = new Database("sqlite:///:memory:");
  const question =
    "When did the pain start and how has it changed since you first noticed it?";
  const finalDiagnosis =
    "A final clinical diagnosis supported by the history and examination findings with more than fifteen words";
  const sentQuestions = [
    question,
    "  " + question.replaceAll(" ", "\t\n\u00a0") + "  ",
    "What's changed about this well-defined pain since yesterday and what makes it better or worse?",
  ];
  let doctorCalls = 0;
  let patientCalls = 0;
  const recordedVersions: string[] = [];
  try {
    const result = await runSimulation(
      db,
      spec,
      "anthropic/claude-sonnet-5.5",
      stub((messages, model) => {
        if (model === "anthropic/claude-sonnet-5.5") {
          assert.match(messages[0].content, /at most 10 words long/);
          assert.match(messages[0].content, /Ask only closed-ended questions/);
          assert.equal(
            messages.at(-1)?.content,
            DOCTOR_TURN_INSTRUCTIONS[doctorCalls],
          );
          return JSON.stringify(
            doctorCalls < 3
              ? { question: sentQuestions[doctorCalls++] }
              : { diagnoses: [{ diagnosis: finalDiagnosis, confidence: 4 }] },
          );
        }
        const input = JSON.parse(messages[1].content);
        assert.equal(input.question, sentQuestions[patientCalls].trim());
        assert.equal(input.previous_questions.length, patientCalls++);
        return JSON.stringify({ fact_ids: [], answer: "I'm not sure." });
      }),
      async (role, _reply, version) => {
        if (role === "doctor") recordedVersions.push(version);
      },
      async () => {},
    );
    assert.equal(patientCalls, 3);
    assert.equal(result.questions_used, 3);
    assert.equal(result.diagnoses[0].diagnosis, finalDiagnosis);
    assert.equal(result.protocol_version, PROMPT_VERSION);
    assert.deepEqual(recordedVersions, Array(4).fill(PROMPT_VERSION));
  } finally {
    await db.close();
  }
});

test("overlong doctor questions are truncated in every round and the interview completes", async () => {
  const db = new Database("sqlite:///:memory:");
  const tooLong =
    "When did your current pain start and how has it changed since you first noticed it?";
  const truncated =
    "When did your current pain start and how has it changed since you first noticed";
  try {
    for (const shortenedRound of [1, 2, 3]) {
      let doctorCalls = 0;
      let patientCalls = 0;
      const recordedQuestions: string[] = [];
      const expectedQuestions = [1, 2, 3].map((round) =>
        round === shortenedRound ? truncated : "Any pain?",
      );
      const result = await runSimulation(
        db,
        spec,
        "anthropic/claude-sonnet-5.5",
        stub((messages, model) => {
          if (model === "anthropic/claude-sonnet-5.5") {
            const history = messages
              .filter((m) => m.role === "assistant")
              .map((m) => JSON.parse(m.content).question);
            assert.deepEqual(history, expectedQuestions.slice(0, doctorCalls));
            doctorCalls++;
            return JSON.stringify(
              doctorCalls <= 3
                ? {
                    question:
                      doctorCalls === shortenedRound ? tooLong : "Any pain?",
                  }
                : { diagnoses: [{ diagnosis: "Assessment", confidence: 4 }] },
            );
          }
          const input = JSON.parse(messages[1].content);
          assert.equal(input.question, expectedQuestions[patientCalls]);
          assert.deepEqual(
            input.previous_questions.map(
              (q: { question: string }) => q.question,
            ),
            expectedQuestions.slice(0, patientCalls),
          );
          patientCalls++;
          return JSON.stringify({ fact_ids: [], answer: "I'm not sure." });
        }),
        async (role, reply) => {
          if (role === "doctor" && doctorCalls <= 3) {
            recordedQuestions.push(JSON.parse(reply.content).question);
            assert.equal(
              parseDoctorQuestion(reply.content),
              expectedQuestions[doctorCalls - 1],
            );
          }
        },
        async () => {},
      );
      assert.equal(doctorCalls, 4);
      assert.equal(patientCalls, 3);
      assert.equal(result.questions_used, 3);
      assert.equal(result.diagnoses[0].diagnosis, "Assessment");
      assert.equal(recordedQuestions[shortenedRound - 1], tooLong);
    }
  } finally {
    await db.close();
  }
});

test("doctor truncation preserves whitespace and punctuation and handles long, fenced output", () => {
  const firstFifteen =
    "What's changed about this well-defined pain since yesterday and what makes it better or worse?";
  const mixed = firstFifteen.replaceAll(" ", "\t\n\u00a0");
  for (const content of [
    JSON.stringify({ question: "  " + mixed + " ADDITIONAL INFORMATION  " }),
    [
      "```json",
      JSON.stringify({ question: mixed + " additional".repeat(1000) }),
      "```",
    ].join("\n"),
  ]) {
    assert.equal(parseDoctorQuestion(content), mixed);
  }
  assert.equal(
    parseDoctorQuestion(JSON.stringify({ question: " Any pain? " })),
    "Any pain?",
  );
});

test("LLM output requires exactly one diagnosis with the physician confidence scale", () => {
  for (const confidence of [1, 4, 7])
    assert.ok(
      DoctorDiagnosesSchema.safeParse({
        diagnoses: [{ diagnosis: "A", confidence }],
      }).success,
    );
  for (const diagnoses of [
    [],
    [{ diagnosis: "A", confidence: 0 }],
    [{ diagnosis: "A", confidence: 8 }],
    [{ diagnosis: "A", confidence: 3.5 }],
    [{ diagnosis: " ", confidence: 4 }],
    [
      { diagnosis: "A", confidence: 4 },
      { diagnosis: "B", confidence: 4 },
    ],
    [{ diagnosis: "", confidence: 100 }],
    [{ diagnosis: "A", confidence: 101 }],
    [{ diagnosis: "A", confidence: -1 }],
    [
      { diagnosis: "A", confidence: 0.5 },
      { diagnosis: "B", confidence: 99.5 },
    ],
    [
      { diagnosis: "A", confidence: 20 },
      { diagnosis: "B", confidence: 80 },
    ],
    [
      { diagnosis: "A", confidence: 50 },
      { diagnosis: " a ", confidence: 50 },
    ],
  ])
    assert.equal(DoctorDiagnosesSchema.safeParse({ diagnoses }).success, false);
  assert.equal(
    RankedDiagnosesSchema.safeParse([
      { diagnosis: "A", probability: 20 },
      { diagnosis: "B", probability: 80 },
      { diagnosis: "", probability: 0 },
    ]).success,
    false,
  );
});
