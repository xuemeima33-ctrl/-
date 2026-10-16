import { test } from "node:test";
import assert from "node:assert/strict";
import {
  publicIPv4,
  validateTarget,
  queryText,
  signCity,
  readCity,
  Store,
  upstream,
} from "../src/security.js";
test("AC01-01 Unicode code point bounds", () => {
  assert.equal(queryText(" 😀 "), "😀");
  assert.equal(queryText("é".repeat(100)).length, 100);
  for (const v of ["", null, {}, "😀".repeat(101)])
    assert.throws(() => queryText(v));
});
test("AC06-03 fixed origins and public DNS", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "172.16.0.1",
    "100.64.1.1",
    "::1",
    "::ffff:8.8.8.8",
    "0.0.0.0",
    "224.0.0.1",
  ])
    assert.equal(publicIPv4(ip), false);
  assert.equal(publicIPv4("8.8.8.8"), true);
  for (const url of [
    "http://api.open-meteo.com/v1/forecast",
    "https://api.open-meteo.com:8443/v1/forecast",
    "https://x@api.open-meteo.com/v1/forecast",
    "https://127.0.0.1/v1/forecast",
    "https://api.open-meteo.com/other",
  ])
    assert.throws(() => validateTarget(url, ["api.open-meteo.com"]));
  assert.doesNotThrow(() =>
    validateTarget("https://api.open-meteo.com/v1/forecast", [
      "api.open-meteo.com",
    ]),
  );
});
const city = {
  id: 1,
  name: "北京",
  country: "中国",
  latitude: 39.9,
  longitude: 116.4,
  timezone: "Asia/Shanghai",
};
test("AC06-02 signed city prevents arbitrary coordinates or timezone", () => {
  const token = signCity(city, "a".repeat(32));
  assert.deepEqual(readCity(token, "a".repeat(32)), city);
  assert.throws(() => readCity(token + "x", "a".repeat(32)));
  assert.throws(() => readCity(token, "b".repeat(32)));
  assert.throws(() => signCity({ ...city, latitude: 91 }, "a".repeat(32)));
});
test("AC06-04/05 atomic rate windows, quota and cache TTL", () => {
  const s = new Store(":memory:");
  assert.equal(s.consume("ip", 2, 1000, 0), 0);
  assert.equal(s.consume("ip", 2, 1000, 0), 0);
  assert.equal(s.consume("ip", 2, 1000, 0), 1);
  assert.equal(s.consume("ip", 2, 1000, 1000), 0);
  s.put("c", { a: 1 }, 0, 600000);
  assert.deepEqual(s.get("c", 599999), { a: 1 });
  assert.equal(s.get("c", 600000), null);
  s.close();
});
test("AC04-02 conditional retry only network and 5xx; quota each attempt", async () => {
  for (const [code, want] of [
    [500, 2],
    [401, 1],
    [403, 1],
    [429, 1],
    [302, 1],
  ]) {
    let n = 0,
      q = 0;
    await assert.rejects(
      upstream(new URL("https://api.open-meteo.com/v1/forecast"), {
        hosts: ["api.open-meteo.com"],
        deadline: Date.now() + 1000,
        reserve: () => q++,
        transport: async () => {
          n++;
          const e = new Error();
          e.status = code;
          throw e;
        },
      }),
    );
    assert.equal(n, want);
    assert.equal(q, want);
  }
  let n = 0;
  assert.deepEqual(
    await upstream(new URL("https://api.open-meteo.com/v1/forecast"), {
      hosts: ["api.open-meteo.com"],
      deadline: Date.now() + 1000,
      reserve: () => {},
      transport: async () => {
        if (++n === 1) {
          const e = new Error();
          e.code = "ECONNRESET";
          throw e;
        }
        return { ok: true };
      },
    }),
    { ok: true },
  );
});

test("AC06-03 DNS private/mixed answers never open a socket; validated address is pinned", async () => {
  const { transport } = await import("../src/security.js");
  const { EventEmitter } = await import("node:events");
  let sockets = 0;
  for (const answers of [[], ["127.0.0.1"], ["8.8.8.8", "169.254.169.254"]])
    await assert.rejects(
      transport(
        new URL("https://api.open-meteo.com/v1/forecast"),
        new AbortController().signal,
        {
          lookup: async () => answers,
          requestImpl: () => {
            sockets++;
          },
        },
      ),
      (e) => e.code === "forbidden_target",
    );
  assert.equal(sockets, 0);
  const result = await transport(
    new URL("https://api.open-meteo.com/v1/forecast"),
    new AbortController().signal,
    {
      lookup: async () => ["8.8.8.8"],
      requestImpl: (u, opts, onResponse) => {
        sockets++;
        opts.lookup(u.hostname, { all: true }, (e, addresses) =>
          assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]),
        );
        assert.equal(opts.agent, false);
        const req = new EventEmitter();
        req.end = () => {
          const res = new EventEmitter();
          res.statusCode = 200;
          onResponse(res);
          res.emit("data", Buffer.from('{"ok":true}'));
          res.emit("end");
        };
        return req;
      },
    },
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(sockets, 1);
});
test("AC06-01/03 transport rejects redirects, malformed JSON and parses Retry-After safely", async () => {
  const { transport } = await import("../src/security.js");
  const { EventEmitter } = await import("node:events");
  for (const [status, body, header, retry] of [
    [302, "", undefined, undefined],
    [429, "", "bad", 30],
    [429, "", "99999", 3600],
    [429, "", new Date(Date.now() + 60000).toUTCString(), 60],
    [200, "{bad", undefined, undefined],
  ]) {
    const requestImpl = (_u, _opts, callback) => {
      const req = new EventEmitter();
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = status;
        res.headers = { "retry-after": header };
        res.destroy = () => {};
        callback(res);
        if (status === 200) {
          res.emit("data", Buffer.from(body));
          res.emit("end");
        }
      };
      return req;
    };
    await assert.rejects(
      transport(
        new URL("https://api.open-meteo.com/v1/forecast"),
        new AbortController().signal,
        { lookup: async () => ["8.8.8.8"], requestImpl },
      ),
      (e) => {
        if (retry !== undefined)
          assert.ok(Math.abs(e.retry_after - retry) <= 1);
        return status === 200 ? e.code === "invalid_data" : e.status === status;
      },
    );
  }
});
