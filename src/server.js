import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  AppError,
  queryText,
  signCity,
  readCity,
  Store,
  upstream,
} from "./security.js";
import {
  current,
  forecast,
  dailyRows,
  dates,
  failure,
  aggregate,
} from "./weather.js";
const root = fileURLToPath(new URL("../public/", import.meta.url));
const positive = (env, key) => {
  const n = Number(env[key]);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new Error(`Missing/invalid server configuration: ${key}`);
  return n;
};
export function configuration(env = process.env) {
  const demo = env.DEMO_MODE === "1";
  if (demo && env.NODE_ENV === "production")
    throw new Error("DEMO_MODE is disabled in production");
  if (
    !demo &&
    (!env.CITY_SIGNING_SECRET || env.CITY_SIGNING_SECRET.length < 32)
  )
    throw new Error("CITY_SIGNING_SECRET must contain at least 32 characters");
  const hosts = (env.ALLOWED_HOSTS || "").split(",").filter(Boolean);
  if (
    !demo &&
    (!hosts.includes(
      env.WEATHER_API_KEY
        ? "customer-geocoding-api.open-meteo.com"
        : "geocoding-api.open-meteo.com",
    ) ||
      !hosts.includes(
        env.WEATHER_API_KEY
          ? "customer-api.open-meteo.com"
          : "api.open-meteo.com",
      ))
  )
    throw new Error("Explicit ALLOWED_HOSTS must include provider hosts");
  return {
    demo,
    secret:
      env.CITY_SIGNING_SECRET ||
      (demo ? "local-demo-only-signing-secret-123456" : ""),
    hosts,
    apiKey: env.WEATHER_API_KEY,
    ipLimit: demo ? 120 : positive(env, "IP_LIMIT"),
    ipWindow: (demo ? 60 : positive(env, "IP_WINDOW_SECONDS")) * 1000,
    quota: demo ? 1000 : positive(env, "UPSTREAM_BUDGET"),
    quotaWindow:
      (demo ? 3600 : positive(env, "UPSTREAM_WINDOW_SECONDS")) * 1000,
    db: env.DB_PATH || "weather.sqlite",
  };
}
const demoCities = [
  {
    id: 1816670,
    name: "北京",
    admin: "北京市",
    country: "中国",
    latitude: 39.9,
    longitude: 116.4,
    timezone: "Asia/Shanghai",
  },
  {
    id: 1850147,
    name: "东京",
    admin: "东京都",
    country: "日本",
    latitude: 35.7,
    longitude: 139.7,
    timezone: "Asia/Tokyo",
  },
  {
    id: 5128581,
    name: "New York",
    admin: "New York",
    country: "美国",
    latitude: 40.7,
    longitude: -74,
    timezone: "America/New_York",
  },
  {
    id: 4409896,
    name: "Springfield",
    admin: "Missouri",
    country: "美国",
    latitude: 37.2,
    longitude: -93.3,
    timezone: "America/Chicago",
  },
  {
    id: 4250542,
    name: "Springfield",
    admin: "Illinois",
    country: "美国",
    latitude: 39.8,
    longitude: -89.6,
    timezone: "America/Chicago",
  },
];
export function createApp(
  config,
  { store = new Store(config.db), send = upstream, clock = Date.now } = {},
) {
  const reserve = () => {
    const key =
      "quota:" +
      createHash("sha256")
        .update(config.apiKey || "open-meteo-free-account")
        .digest("hex");
    const wait = store.consume(key, config.quota, config.quotaWindow, clock());
    if (wait) throw new AppError("quota_exhausted", 429, wait);
  };
  const provider = async (url, deadline, signal) => {
    if (config.apiKey && url.hostname.startsWith("customer-"))
      url.searchParams.set("apikey", config.apiKey);
    return send(url, { hosts: config.hosts, deadline, reserve, signal });
  };
  async function search(q, deadline, signal) {
    if (config.demo)
      return demoCities.filter((c) =>
        `${c.name} ${c.country} ${c.admin}`
          .toLowerCase()
          .includes(q.toLowerCase()),
      );
    const cached = store.get("search:" + q, clock());
    if (cached) return cached;
    const url = new URL(
      `https://${config.apiKey ? "customer-geocoding-api" : "geocoding-api"}.open-meteo.com/v1/search`,
    );
    url.search = new URLSearchParams({
      name: q,
      count: "20",
      language: "zh",
      format: "json",
    });
    const raw = await provider(url, deadline, signal);
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      (!("results" in raw) && !Number.isFinite(raw.generationtime_ms)) ||
      ("results" in raw && !Array.isArray(raw.results))
    )
      throw new AppError("invalid_data", 502);
    const result = (raw.results || []).map((c) => ({
      id: c.id,
      name: c.name,
      country: c.country,
      admin: [c.admin1, c.admin2].filter(Boolean).join(" · "),
      latitude: c.latitude,
      longitude: c.longitude,
      timezone: c.timezone,
    }));
    store.put("search:" + q, result, clock(), 600000);
    return result;
  }
  async function block(module, city, ref, deadline, signal) {
    try {
      if (config.demo) {
        const fetched = clock();
        if (module === "current")
          return current(
            {
              time: Math.floor(ref / 1000),
              temperature_2m: 18.4,
              apparent_temperature: 17.2,
              relative_humidity_2m: 62,
              wind_speed_10m: 2.8,
              weather_code: 2,
            },
            {
              temperature_2m: "°C",
              apparent_temperature: "°C",
              relative_humidity_2m: "%",
              wind_speed_10m: "m/s",
            },
            city.timezone,
            ref,
            fetched,
          );
        return forecast(
          dates(ref, city.timezone).map((date, i) => ({
            date,
            max: 20 + i,
            min: 10 + i,
            code: [2, 0, 3, 61, 1][i],
          })),
          city.timezone,
          ref,
          fetched,
        );
      }
      const key = `${module}:${city.id}:${city.latitude}:${city.longitude}:${city.timezone}`;
      const normalize = (entry) =>
        module === "current"
          ? current(
              entry.raw.current,
              entry.raw.current_units,
              city.timezone,
              ref,
              entry.fetched,
            )
          : forecast(dailyRows(entry.raw), city.timezone, ref, entry.fetched);
      const cached = store.get(key, ref);
      if (cached) {
        const n = normalize(cached);
        const mapped = dailyRows(cached.raw);
        if (
          n.status === "success" &&
          n.completeness === "complete" &&
          (module === "current" ||
            dates(ref, city.timezone).every((d) =>
              mapped?.some((r) => r.date === d),
            ))
        )
          return n;
      }
      const url = new URL(
        `https://${config.apiKey ? "customer-api" : "api"}.open-meteo.com/v1/forecast`,
      );
      url.search = new URLSearchParams({
        latitude: String(city.latitude),
        longitude: String(city.longitude),
        timezone: city.timezone,
        timeformat: module === "current" ? "unixtime" : "iso8601",
        temperature_unit: "celsius",
        wind_speed_unit: "ms",
        forecast_days: "7",
        ...(module === "current"
          ? {
              current:
                "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code",
            }
          : { daily: "temperature_2m_max,temperature_2m_min,weather_code" }),
      });
      const raw = await provider(url, deadline, signal);
      const fetched = clock();
      // Use provider date labels directly: a fixed-offset midnight timestamp can
      // fall on the previous local date after the autumn DST transition.
      const entry = { raw, fetched };
      const n = normalize(entry);
      if (n.status === "success")
        store.put(key, entry, fetched, module === "current" ? 600000 : 3600000);
      return n;
    } catch (e) {
      return {
        ...failure(
          ["timeout", "quota_exhausted", "stale_data"].includes(e.code)
            ? e.code
            : "unavailable",
        ),
        ...(e.retry_after
          ? { retry_after: Math.min(3600, e.retry_after) }
          : {}),
      };
    }
  }
  const server = createServer(async (req, res) => {
    const json = (status, data) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...(data.retry_after
          ? { "Retry-After": String(data.retry_after) }
          : {}),
      });
      res.end(JSON.stringify(data));
    };
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method !== "GET")
        return json(405, { error_code: "method_not_allowed" });
      if (url.pathname.startsWith("/api/")) {
        const allowed =
          url.pathname === "/api/search"
            ? ["q"]
            : url.pathname === "/api/weather"
              ? ["city_key", "module"]
              : [];
        if (!allowed.length) throw new AppError("not_found", 404);
        for (const k of url.searchParams.keys())
          if (!allowed.includes(k) || url.searchParams.getAll(k).length !== 1)
            throw new AppError("invalid_parameters", 400);
        let q, city, module;
        if (url.pathname === "/api/search")
          q = queryText(url.searchParams.get("q"));
        else {
          city = readCity(url.searchParams.get("city_key"), config.secret);
          module = url.searchParams.get("module") || "both";
          if (!["both", "current", "forecast"].includes(module))
            throw new AppError("invalid_parameters", 400);
        }
        // Never trust a user supplied X-Forwarded-For. See README for reverse proxy deployment.
        const ip = req.socket.remoteAddress || "unknown";
        const wait = store.consume(
          "ip:" + createHash("sha256").update(ip).digest("hex"),
          config.ipLimit,
          config.ipWindow,
          clock(),
        );
        if (wait) throw new AppError("rate_limited", 429, Math.min(3600, wait));
        const ref = clock(),
          deadline = Date.now() + 10000,
          controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        res.on("close", () => controller.abort());
        try {
          if (q !== undefined) {
            const candidates = (
              await search(q, deadline, controller.signal)
            ).map((c) => {
              try {
                return {
                  ...c,
                  city_key: signCity(c, config.secret),
                  selectable: true,
                };
              } catch {
                return { ...c, selectable: false };
              }
            });
            return json(200, { candidates, demo: config.demo });
          }
          const request_id = randomUUID();
          const names = module === "both" ? ["current", "forecast"] : [module];
          const values = await Promise.all(
            names.map((n) => block(n, city, ref, deadline, controller.signal)),
          );
          const blocks = Object.fromEntries(
            names.map((n, i) => [n, values[i]]),
          );
          return json(200, {
            ...blocks,
            ...(module === "both"
              ? { state: aggregate(blocks.current, blocks.forecast) }
              : {}),
            reference_at: ref,
            server_at: clock(),
            timezone: city.timezone,
            request_id,
            demo: config.demo,
          });
        } finally {
          clearTimeout(timer);
        }
      }
      const files = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/app.js": ["app.js", "text/javascript; charset=utf-8"],
        "/state.js": ["state.js", "text/javascript; charset=utf-8"],
        "/style.css": ["style.css", "text/css; charset=utf-8"],
      };
      const f = files[url.pathname];
      if (!f) return json(404, { error_code: "not_found" });
      const body = await readFile(resolve(root, f[0]));
      res.writeHead(200, { "Content-Type": f[1], "Cache-Control": "no-cache" });
      res.end(body);
    } catch (e) {
      if (!res.headersSent)
        json(
          e instanceof AppError
            ? [400, 404, 429, 504].includes(e.status)
              ? e.status
              : 503
            : 503,
          {
            error_code: e instanceof AppError ? e.code : "unavailable",
            ...(e.retry_after
              ? { retry_after: Math.min(3600, e.retry_after) }
              : {}),
          },
        );
      else res.end();
    }
  });
  server.requestTimeout = 11000;
  server.headersTimeout = 10000;
  server.on("close", () => store.close());
  return server;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const config = configuration();
  const server = createApp(config);
  server.listen(
    Number(process.env.PORT || 3000),
    process.env.HOST || "127.0.0.1",
    () =>
      console.log(
        `Weather server listening on ${server.address().port}${config.demo ? " (DEMO — synthetic weather)" : ""}`,
      ),
  );
}
