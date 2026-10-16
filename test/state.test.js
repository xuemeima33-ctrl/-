import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextMidnight,
  localDate,
  retrySeconds,
  Versions,
} from "../public/state.js";
test("AC04-05 midnight timer follows 23h/25h DST dates", () => {
  for (const [start, end] of [
    ["2026-03-08T05:00Z", "2026-03-09T04:00Z"],
    ["2026-11-01T04:00Z", "2026-11-02T05:00Z"],
  ])
    assert.equal(
      nextMidnight(Date.parse(start), "America/New_York"),
      Date.parse(end),
    );
  assert.equal(
    localDate(Date.parse("2026-10-16T23:00Z"), "Asia/Tokyo"),
    "2026-10-17",
  );
});
test("AC04-03 city switch and invalidated search reject old versions", () => {
  const v = new Versions(),
    a = v.start(),
    b = v.start();
  assert.equal(a.signal.aborted, true);
  assert.equal(v.valid(a.version), false);
  assert.equal(v.valid(b.version), true);
  v.cancel();
  assert.equal(v.valid(b.version), false);
});
test("AC04-02 Retry-After default/clamp/date parsing", () => {
  const now = Date.parse("2026-10-16T12:00Z");
  for (const v of [
    0,
    -1,
    "bad",
    "0",
    "-1",
    undefined,
    "Fri, 16 Oct 2026 11:59:00 GMT",
  ])
    assert.equal(retrySeconds(v, now), 30);
  assert.equal(retrySeconds("99999", now), 3600);
  assert.equal(retrySeconds("Fri, 16 Oct 2026 12:00:31 GMT", now), 31);
});
