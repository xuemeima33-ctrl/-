import { createHmac, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolve4 } from "node:dns/promises";
import { request } from "node:https";
import { isIPv4 } from "node:net";
export class AppError extends Error {
  constructor(code = "unavailable", status = 503, retry_after) {
    super(code);
    this.code = code;
    this.status = status;
    this.retry_after = retry_after;
  }
}
export function queryText(q) {
  if (
    typeof q !== "string" ||
    ![...q.trim()].length ||
    [...q.trim()].length > 100
  )
    throw new AppError("invalid_query", 400);
  return q.trim();
}
export function publicIPv4(ip) {
  if (!isIPv4(ip)) return false;
  const [a, b, c] = ip.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 &&
      (b === 168 || b === 0 || b === 2 || (b === 88 && c === 99))) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && c === 113)
  );
}
export function validateTarget(value, hosts) {
  const u = new URL(value);
  const paths = {
    "geocoding-api.open-meteo.com": "/v1/search",
    "customer-geocoding-api.open-meteo.com": "/v1/search",
    "api.open-meteo.com": "/v1/forecast",
    "customer-api.open-meteo.com": "/v1/forecast",
  };
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    u.hash ||
    !hosts.includes(u.hostname) ||
    u.pathname !== paths[u.hostname]
  )
    throw new AppError("forbidden_target", 400);
  return u;
}
function validCity(c) {
  try {
    return (
      c &&
      Number.isSafeInteger(c.id) &&
      c.id > 0 &&
      typeof c.name === "string" &&
      c.name.length > 0 &&
      c.name.length <= 200 &&
      typeof c.country === "string" &&
      c.country.length > 0 &&
      c.country.length <= 200 &&
      Number.isFinite(c.latitude) &&
      Math.abs(c.latitude) <= 90 &&
      Number.isFinite(c.longitude) &&
      Math.abs(c.longitude) <= 180 &&
      typeof c.timezone === "string" &&
      Boolean(new Intl.DateTimeFormat("en", { timeZone: c.timezone }).format())
    );
  } catch {
    return false;
  }
}
export function signCity(c, secret) {
  if (!validCity(c)) throw new AppError("invalid_city", 400);
  const body = Buffer.from(JSON.stringify(c)).toString("base64url");
  if (body.length + 44 > 4096) throw new AppError("invalid_city", 400);
  return (
    body + "." + createHmac("sha256", secret).update(body).digest("base64url")
  );
}
export function readCity(token, secret) {
  try {
    if (typeof token !== "string" || token.length > 4096) throw 0;
    const [body, sig, ...rest] = token.split(".");
    const expected = createHmac("sha256", secret).update(body).digest();
    const got = Buffer.from(sig, "base64url");
    if (
      rest.length ||
      got.length !== expected.length ||
      !timingSafeEqual(got, expected)
    )
      throw 0;
    const c = JSON.parse(Buffer.from(body, "base64url"));
    if (!validCity(c)) throw 0;
    return c;
  } catch {
    throw new AppError("invalid_city", 400);
  }
}
export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, n INTEGER, until INTEGER); CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, value TEXT, until INTEGER);",
    );
  }
  consume(key, limit, window, now = Date.now()) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM counters WHERE until<=?").run(now);
      const r = this.db
        .prepare("SELECT n,until FROM counters WHERE k=?")
        .get(key);
      if (r && r.n >= limit) {
        this.db.exec("COMMIT");
        return Math.max(1, Math.ceil((r.until - now) / 1000));
      }
      this.db
        .prepare(
          "INSERT INTO counters VALUES (?,1,?) ON CONFLICT(k) DO UPDATE SET n=n+1",
        )
        .run(key, now + window);
      this.db.exec("COMMIT");
      return 0;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  get(k, now = Date.now()) {
    const r = this.db.prepare("SELECT value,until FROM cache WHERE k=?").get(k);
    return r && now < r.until ? JSON.parse(r.value) : null;
  }
  put(k, value, now, ttl) {
    this.db.prepare("DELETE FROM cache WHERE until<=?").run(now);
    this.db
      .prepare(
        "INSERT INTO cache VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET value=excluded.value, until=excluded.until",
      )
      .run(k, JSON.stringify(value), now + ttl);
  }
  close() {
    this.db.close();
  }
}
// Validate every resolved address, then pin the selected address to the TLS socket.
// The original host remains the TLS SNI and certificate verification name.
export async function transport(
  url,
  signal,
  { lookup = resolve4, requestImpl = request } = {},
) {
  const ips = await lookup(url.hostname);
  if (!ips.length || ips.some((ip) => !publicIPv4(ip)))
    throw new AppError("forbidden_target", 400);
  if (signal.aborted) throw new AppError("timeout", 504);
  return new Promise((resolve, reject) => {
    const req = requestImpl(
      url,
      {
        signal,
        agent: false,
        lookup: (_h, opts, cb) =>
          opts.all
            ? cb(null, [{ address: ips[0], family: 4 }])
            : cb(null, ips[0], 4),
        headers: { Accept: "application/json" },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.destroy();
          const err = new AppError("upstream_error", res.statusCode);
          const header = res.headers["retry-after"];
          const retry =
            typeof header === "string" && /^\d+$/.test(header)
              ? Number(header)
              : Math.ceil((Date.parse(header) - Date.now()) / 1000);
          if (res.statusCode === 429)
            err.retry_after =
              Number.isFinite(retry) && retry > 0
                ? Math.min(3600, Math.ceil(retry))
                : 30;
          reject(err);
          return;
        }
        let body = "",
          size = 0;
        res.on("data", (b) => {
          size += b.length;
          if (size > 2_000_000) req.destroy(new AppError("invalid_data", 502));
          else body += b;
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new AppError("invalid_data", 502));
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}
export async function upstream(
  url,
  { hosts, deadline, reserve, transport: send = transport, signal },
) {
  validateTarget(url, hosts);
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = deadline - Date.now();
    if (left <= 0 || signal?.aborted) throw new AppError("timeout", 504);
    reserve();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let timer;
    try {
      return await Promise.race([
        send(url, controller.signal),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => {
              controller.abort();
              reject(new AppError("timeout", 504));
            },
            Math.min(10000, left),
          );
        }),
        new Promise((_, reject) =>
          controller.signal.addEventListener(
            "abort",
            () => reject(new AppError("timeout", 504)),
            { once: true },
          ),
        ),
      ]);
    } catch (e) {
      if (
        controller.signal.aborted ||
        e.code === "ABORT_ERR" ||
        Date.now() >= deadline
      )
        throw new AppError("timeout", 504);
      const network = [
        "ECONNRESET",
        "ECONNREFUSED",
        "ENOTFOUND",
        "EAI_AGAIN",
        "EPIPE",
        "ETIMEDOUT",
      ].includes(e.code);
      if (
        attempt === 1 ||
        !(network || e.status >= 500) ||
        e.code === "invalid_data" ||
        e.code === "timeout"
      )
        throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}
