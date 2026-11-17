import test from "node:test";
import assert from "node:assert/strict";
import { timingClock } from "../../web/lib/timing-clock.js";
test("timing clock includes background time only in elapsed time and handles monotonic retries", () => {
  const clock = timingClock(1000, true);
  assert.deepEqual(clock(6000, false), { elapsed_ms: 5000, active_ms: 5000 });
  assert.deepEqual(clock(16000, true), { elapsed_ms: 15000, active_ms: 5000 });
  assert.deepEqual(clock(18000, true), { elapsed_ms: 17000, active_ms: 7000 });
  assert.deepEqual(clock(17000, true), { elapsed_ms: 17000, active_ms: 7000 });
});
