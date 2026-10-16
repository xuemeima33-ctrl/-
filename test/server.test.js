import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, configuration } from "../src/server.js";
import { Store, AppError, signCity, upstream } from "../src/security.js";
import { localDate } from "../src/weather.js";
const city = {
  id: 1816670,
  name: "北京",
  country: "中国",
  latitude: 39.9,
  longitude: 116.4,
  timezone: "Asia/Shanghai",
};
const cfg = () => ({
  ...configuration({ DEMO_MODE: "1", DB_PATH: ":memory:" }),
  demo: false,
  hosts: ["api.open-meteo.com", "geocoding-api.open-meteo.com"],
  ipLimit: 1000,
});
const ref = Date.parse("2026-10-16T12:01:00Z");
const raw = (url, now = ref) =>
  url.hostname.startsWith("geocoding")
    ? { results: [city] }
    : url.searchParams.has("current")
      ? {
          current: {
            time: Math.floor(now / 1000),
            temperature_2m: 0,
            apparent_temperature: -1.5,
            relative_humidity_2m: 50,
            wind_speed_10m: 3,
            weather_code: 0,
          },
          current_units: {
            temperature_2m: "°C",
            apparent_temperature: "°C",
            relative_humidity_2m: "%",
            wind_speed_10m: "m/s",
          },
        }
      : {
          daily: {
            time: Array.from({ length: 7 }, (_, i) => {
              const d = new Date(localDate(now, city.timezone) + "T12:00:00Z");
              d.setUTCDate(d.getUTCDate() + i);
              return d.toISOString().slice(0, 10);
            }),
            temperature_2m_max: Array(7).fill(20),
            temperature_2m_min: Array(7).fill(10),
            weather_code: Array(7).fill(0),
          },
          daily_units: { temperature_2m_max: "°C", temperature_2m_min: "°C" },
        };
async function fixture(
  t,
  config = cfg(),
  send = async (u) => raw(u),
  clock = () => ref,
) {
  const server = createApp(config, { send, clock });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = "http://127.0.0.1:" + server.address().port;
  return {
    get: async (p, options) => {
      const r = await fetch(base + p, options);
      return { status: r.status, data: await r.json() };
    },
    base,
  };
}
const weather = (c) =>
  "/api/weather?" + new URLSearchParams({ city_key: signCity(city, c.secret) });
test("AC06-06 fails closed without production configuration", () => {
  for (const env of [
    {},
    { DEMO_MODE: "1", NODE_ENV: "production" },
    { CITY_SIGNING_SECRET: "a".repeat(32) },
  ])
    assert.throws(() => configuration(env));
});
test("AC06-02 reject extra/duplicate/unsigned parameters without upstream calls", async (t) => {
  let n = 0;
  const c = cfg(),
    { get } = await fixture(t, c, async () => {
      n++;
      return {};
    });
  for (const p of [
    "/api/search?q=",
    "/api/search?q=a&q=b",
    "/api/search?q=a&url=http://127.0.0.1",
    "/api/weather?city_key=bad",
    weather(c) + "&module=no",
  ])
    assert.equal((await get(p)).status, 400);
  assert.equal(n, 0);
});
test("AC01/02/03 real adapter, explicit candidates, module cache TTL", async (t) => {
  let n = 0,
    time = ref;
  const c = cfg(),
    { get } = await fixture(
      t,
      c,
      async (u) => {
        n++;
        return raw(u, time);
      },
      () => time,
    );
  const s = await get("/api/search?q=北京");
  assert.equal(s.data.candidates[0].selectable, true);
  const key = s.data.candidates[0].city_key;
  const p = "/api/weather?" + new URLSearchParams({ city_key: key });
  const first = (await get(p)).data;
  assert.equal(first.state, "ready");
  assert.equal(first.current.data.temperature, 0);
  assert.equal(first.forecast.data.length, 5);
  assert.equal(first.forecast.data[0].date, "2026-10-17");
  assert.equal(n, 3);
  const repeat = (await get(p)).data;
  assert.equal(n, 3);
  assert.equal(repeat.current.fetched_at, first.current.fetched_at);
  time += 600000;
  assert.equal((await get(p)).data.state, "ready");
  assert.equal(n, 4);
  time = Date.parse("2026-10-16T16:01Z");
  const midnight = (await get(p)).data;
  assert.equal(midnight.forecast.data[0].date, "2026-10-18");
  assert.equal(midnight.forecast.reference_at, midnight.current.reference_at);
  assert.equal(n, 6);
});
test("AC06-04 forged forwarded IP cannot bypass rate limit, even cache hits", async (t) => {
  const c = { ...cfg(), ipLimit: 1 };
  const { get } = await fixture(t, c);
  assert.equal(
    (
      await get("/api/search?q=a", {
        headers: { "X-Forwarded-For": "1.1.1.1" },
      })
    ).status,
    200,
  );
  const r = await get("/api/search?q=a", {
    headers: { "X-Forwarded-For": "2.2.2.2" },
  });
  assert.equal(r.status, 429);
  assert.equal(r.data.error_code, "rate_limited");
});
test("AC04-01 independent module failure gives partial, no raw secrets", async (t) => {
  const c = cfg(),
    { get } = await fixture(t, c, async (u) => {
      if (u.searchParams.has("daily"))
        throw new Error("secret-key-must-never-leak");
      return raw(u);
    });
  const r = (await get(weather(c))).data;
  assert.equal(r.state, "partial");
  assert.equal(r.forecast.status, "failure");
  assert.equal(JSON.stringify(r).includes("secret-key"), false);
});
test("AC06-05 every retry consumes shared budget; concurrent requests cannot exceed it", async (t) => {
  let calls = 0;
  const c = { ...cfg(), quota: 1 };
  const send = (u, options) =>
    upstream(u, {
      ...options,
      transport: async () => {
        calls++;
        throw new AppError("upstream_error", 500);
      },
    });
  const { get } = await fixture(t, c, send);
  const responses = await Promise.all(
    Array.from({ length: 5 }, () => get(weather(c))),
  );
  assert.equal(calls, 1);
  assert.ok(responses.every((r) => r.data.state === "error"));
});
test("AC04-02 hard budget discards late response and does not retry timeout", async () => {
  let calls = 0;
  await assert.rejects(
    upstream(new URL("https://api.open-meteo.com/v1/forecast"), {
      hosts: ["api.open-meteo.com"],
      deadline: Date.now() + 25,
      reserve: () => {},
      transport: () => {
        calls++;
        return new Promise((r) => setTimeout(() => r({ late: true }), 60));
      },
    }),
    (e) => e.code === "timeout",
  );
  assert.equal(calls, 1);
});
test("AC06-04 shared SQLite store has atomic counters across connections", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(tmpdir() + "/weather-store-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = new Store(dir + "/shared.sqlite"),
    b = new Store(dir + "/shared.sqlite");
  t.after(() => {
    a.close();
    b.close();
  });
  assert.equal(a.consume("quota", 1, 1000, 0), 0);
  assert.equal(b.consume("quota", 1, 1000, 0), 1);
  assert.equal(b.consume("quota", 1, 1000, 1000), 0);
});

test("AC06-01 paid key stays in server transport, never static or error responses", async (t) => {
  const secret = "test-only-sentinel-api-key";
  const c = {
    ...cfg(),
    apiKey: secret,
    hosts: ["customer-api.open-meteo.com", "geocoding-api.open-meteo.com"],
  };
  let captured = 0;
  const { get, base } = await fixture(t, c, async (u) => {
    assert.equal(u.searchParams.get("apikey"), secret);
    captured++;
    throw new Error(secret);
  });
  const r = await get(weather(c));
  assert.equal(captured, 2);
  assert.equal(JSON.stringify(r).includes(secret), false);
  for (const path of ["/", "/app.js", "/state.js", "/style.css"]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.equal((await response.text()).includes(secret), false);
  }
});
test("AC01-03 invalid search structure differs from empty and unselectable", async (t) => {
  for (const [payload, status] of [
    [{}, 503],
    [{ results: [] }, 200],
    [{ results: [{ name: "missing metadata" }] }, 200],
  ]) {
    const { get } = await fixture(t, cfg(), async () => payload);
    const r = await get("/api/search?q=a");
    assert.equal(r.status, status);
    if (payload.results?.length)
      assert.equal(r.data.candidates[0].selectable, false);
  }
});
test("AC04-04 incomplete cache cannot mask a retry", async (t) => {
  let n = 0;
  const c = cfg(),
    { get } = await fixture(t, c, async (u) => {
      n++;
      const data = raw(u);
      if (u.searchParams.has("current"))
        data.current.relative_humidity_2m = null;
      return data;
    });
  const p = weather(c) + "&module=current";
  assert.equal((await get(p)).data.current.completeness, "incomplete");
  await get(p);
  assert.equal(n, 2);
});
