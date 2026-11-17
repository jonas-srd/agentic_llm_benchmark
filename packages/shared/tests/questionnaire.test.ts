import test from "node:test";
import assert from "node:assert/strict";
import {
  POST_SURVEY_STEPS,
  questionVisible,
  updateQuestionnaireAnswer,
  StepSchema,
} from "../src/index.js";

test("changing external support to No removes hidden selections and Yes requires a fresh selection", () => {
  const questions = POST_SURVEY_STEPS[2].questions;
  const previous = {
    external_support_used: true,
    external_support_types: ["AI tools"],
    feedback: "Keep this comment",
  };
  assert.equal(questionVisible(questions[1], previous), true);
  const no = updateQuestionnaireAnswer(
    questions,
    previous,
    "external_support_used",
    false,
  );
  assert.deepEqual(no, {
    external_support_used: false,
    feedback: previous.feedback,
  });
  assert.equal(questionVisible(questions[1], no), false);
  const yes = updateQuestionnaireAnswer(
    questions,
    no,
    "external_support_used",
    true,
  );
  assert.equal(questionVisible(questions[1], yes), true);
  assert.equal(yes.external_support_types, undefined);
});

test("conditions must refer to an earlier question on the same page", () => {
  const step = POST_SURVEY_STEPS[2];
  assert.equal(
    StepSchema.safeParse({ ...step, questions: [...step.questions].reverse() })
      .success,
    false,
  );
  assert.equal(
    StepSchema.safeParse({
      ...step,
      questions: step.questions.map((q) =>
        q.visible_when
          ? { ...q, visible_when: { question_id: "missing", equals: true } }
          : q,
      ),
    }).success,
    false,
  );
});
