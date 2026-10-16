import { test } from "node:test";
import assert from "node:assert/strict";
import { round, dates, current, forecast, aggregate } from "../src/weather.js";
const ref = Date.parse("2026-03-07T23:59:00Z");
const units = {
  temperature_2m: "°C",
  apparent_temperature: "°C",
  relative_humidity_2m: "%",
  wind_speed_10m: "m/s",
};
const raw = {
  time: ref / 1000,
  temperature_2m: 0,
  apparent_temperature: -1.5,
  relative_humidity_2m: 0,
  wind_speed_10m: 1.25,
  weather_code: 0,
};
test("AC02-01 half away from zero; zero retained", () => {
  assert.equal(round(-1.5), -2);
  assert.equal(round(1.25, 1), 1.3);
  assert.equal(round(-0.1), 0);
  const c = current(raw, units, "UTC", ref, ref);
  assert.equal(c.status, "success");
  assert.equal(c.data.temperature, 0);
  assert.equal(c.data.humidity, 0);
});
test("AC02-02/03 time metadata, freshness and future zero tolerance", () => {
  for (const t of [undefined, (ref + 1) / 1000, (ref - 900001) / 1000])
    assert.equal(
      current({ ...raw, time: t }, units, "UTC", ref, ref).status,
      "failure",
    );
  assert.equal(
    current({ ...raw, time: (ref - 900000) / 1000 }, units, "UTC", ref, ref)
      .status,
    "success",
  );
  assert.equal(current(raw, units, "bad zone", ref, ref).status, "failure");
});
test("AC03-01 local calendar DST and different device dates", () => {
  assert.deepEqual(dates(ref, "Pacific/Auckland"), [
    "2026-03-09",
    "2026-03-10",
    "2026-03-11",
    "2026-03-12",
    "2026-03-13",
  ]);
  assert.equal(
    dates(Date.parse("2026-03-08T05:00Z"), "America/New_York")[0],
    "2026-03-09",
  );
});
test("AC03-02/03 duplicate field merge and inverted pair", () => {
  const ds = dates(ref, "UTC");
  const f = forecast(
    [
      { date: ds[0], max: 3, min: 1, code: 0 },
      { date: ds[0], max: 4, min: 1, code: 0 },
      { date: ds[1], max: 0, min: 2, code: 3 },
    ],
    "UTC",
    ref,
    ref,
  );
  assert.equal(f.status, "success");
  assert.equal(f.completeness, "incomplete");
  assert.equal(f.data[0].max, null);
  assert.equal(f.data[0].min, 1);
  assert.equal(f.data[1].max, null);
  assert.equal(f.data[1].condition, "阴");
  assert.equal(f.data[2].day_status, "failure");
  assert.equal(forecast([], "UTC", ref, ref).status, "failure");
});
test("AC04-01 module truth table", () => {
  const ok = { status: "success" },
    bad = { status: "failure" };
  assert.equal(aggregate(ok, ok), "ready");
  assert.equal(aggregate(ok, bad), "partial");
  assert.equal(aggregate(bad, ok), "partial");
  assert.equal(aggregate(bad, bad), "error");
});

test("M01–M13 explicit PRD field completeness and failure matrix", () => {
  const good = current(raw, units, "UTC", ref, ref),
    ds = dates(ref, "UTC"),
    rows = ds.map((date) => ({ date, max: 20, min: 10, code: 0 })),
    goodForecast = forecast(rows, "UTC", ref, ref);
  const cases = [
    ["M01", good, goodForecast, "ready", "complete"],
    [
      "M02",
      current(raw, units, undefined, ref, ref),
      goodForecast,
      "partial",
      "none",
    ],
    [
      "M03",
      current({ time: ref / 1000, temperature_2m: 0 }, units, "UTC", ref, ref),
      goodForecast,
      "ready",
      "incomplete",
    ],
    [
      "M04",
      current({ time: ref / 1000 }, units, "UTC", ref, ref),
      goodForecast,
      "partial",
      "none",
    ],
    [
      "M05",
      good,
      forecast(
        ds.map((date) => ({ date })),
        "UTC",
        ref,
        ref,
      ),
      "partial",
      "none",
    ],
    [
      "M06",
      good,
      forecast([{ date: ds[0], max: 0 }], "UTC", ref, ref),
      "ready",
      "incomplete",
    ],
    [
      "M07",
      good,
      forecast(rows.slice(1), "UTC", ref, ref),
      "ready",
      "incomplete",
    ],
    ["M08", good, forecast(rows, "bad zone", ref, ref), "partial", "none"],
    [
      "M09",
      current(raw, units, "UTC", undefined, ref),
      forecast(rows, "UTC", undefined, ref),
      "error",
      "none",
    ],
    [
      "M10",
      good,
      forecast([{ date: ds[0], max: 1, min: 2, code: 0 }], "UTC", ref, ref),
      "ready",
      "incomplete",
    ],
    [
      "M11",
      good,
      forecast([...rows, ...rows], "UTC", ref, ref),
      "ready",
      "complete",
    ],
    [
      "M12",
      good,
      forecast([...rows, { ...rows[0], code: 3 }], "UTC", ref, ref),
      "ready",
      "incomplete",
    ],
    [
      "M13",
      current({ ...raw, time: (ref - 900001) / 1000 }, units, "UTC", ref, ref),
      goodForecast,
      "partial",
      "none",
    ],
  ];
  for (const [id, c, f, state, complete] of cases) {
    assert.equal(aggregate(c, f), state, id);
    assert.equal(
      (["M01", "M02", "M03", "M04", "M09", "M13"].includes(id) ? c : f)
        .completeness,
      complete,
      id,
    );
  }
  assert.equal(cases[4][2].data.length, 5);
  assert.ok(cases[4][2].data.every((d) => d.day_status === "failure"));
  assert.equal(cases[11][2].data[0].condition, null);
  assert.equal(cases[10][2].data.length, 5);
  assert.equal(
    forecast([{ date: "not-a-date" }], "UTC", ref, ref).status,
    "failure",
  );
});
