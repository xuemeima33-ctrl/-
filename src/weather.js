const codes = {
  0: "晴",
  1: "大部晴朗",
  2: "多云",
  3: "阴",
  45: "雾",
  48: "雾凇",
  51: "小毛毛雨",
  53: "毛毛雨",
  55: "强毛毛雨",
  56: "冻毛毛雨",
  57: "强冻毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "冻雨",
  67: "强冻雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "雪粒",
  80: "小阵雨",
  81: "阵雨",
  82: "强阵雨",
  85: "阵雪",
  86: "强阵雪",
  95: "雷暴",
  96: "雷暴伴冰雹",
  99: "强雷暴伴冰雹",
};
export const finite = (x) => typeof x === "number" && Number.isFinite(x);
export const condition = (x) => (finite(x) ? (codes[x] ?? null) : null);
export function round(x, n = 0) {
  if (!finite(x)) return null;
  const m = 10 ** n;
  return (
    (Math.sign(x) * Math.round((Math.abs(x) + Number.EPSILON) * m)) / m || 0
  );
}
export function localDate(time, zone) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(time);
  return ["year", "month", "day"]
    .map((k) => p.find((v) => v.type === k).value)
    .join("-");
}
export function dates(time, zone) {
  const d = localDate(time, zone);
  return Array.from({ length: 5 }, (_, i) => {
    const t = new Date(d + "T12:00:00Z");
    t.setUTCDate(t.getUTCDate() + i + 1);
    return t.toISOString().slice(0, 10);
  });
}
export const aggregate = (a, b) =>
  a.status === "success"
    ? b.status === "success"
      ? "ready"
      : "partial"
    : b.status === "success"
      ? "partial"
      : "error";
export const failure = (code = "invalid_data") => ({
  status: "failure",
  completeness: "none",
  error_code: code,
});
function meta(zone, ref, fetched) {
  try {
    return Boolean(
      zone && finite(ref) && finite(fetched) && localDate(ref, zone),
    );
  } catch {
    return false;
  }
}
function result(data, values, zone, ref, fetched, extra = {}) {
  const n = values.filter((v) => v !== null).length;
  return n
    ? {
        status: "success",
        completeness: n === values.length ? "complete" : "incomplete",
        data,
        timezone: zone,
        reference_at: ref,
        fetched_at: fetched,
        ...extra,
      }
    : failure();
}
export function current(raw = {}, units = {}, zone, ref, fetched) {
  if (!meta(zone, ref, fetched) || !finite(raw.time)) return failure();
  const updated = raw.time * 1000;
  if (ref - updated < 0 || ref - updated > 900000) return failure("stale_data");
  const data = {
    temperature:
      units.temperature_2m === "°C" ? round(raw.temperature_2m) : null,
    feels_like:
      units.apparent_temperature === "°C"
        ? round(raw.apparent_temperature)
        : null,
    condition: condition(raw.weather_code),
    humidity:
      units.relative_humidity_2m === "%" &&
      finite(raw.relative_humidity_2m) &&
      raw.relative_humidity_2m >= 0 &&
      raw.relative_humidity_2m <= 100
        ? round(raw.relative_humidity_2m)
        : null,
    wind_speed:
      units.wind_speed_10m === "m/s" &&
      finite(raw.wind_speed_10m) &&
      raw.wind_speed_10m >= 0
        ? round(raw.wind_speed_10m, 1)
        : null,
  };
  return result(data, Object.values(data), zone, ref, fetched, {
    updated_at: updated,
    expires_at: fetched + 600000,
  });
}
export function forecast(rows, zone, ref, fetched) {
  if (!meta(zone, ref, fetched) || !Array.isArray(rows)) return failure();
  const valid = rows.filter(
    (r) =>
      r &&
      typeof r.date === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(r.date) &&
      !Number.isNaN(Date.parse(r.date)) &&
      new Date(r.date).toISOString().slice(0, 10) === r.date,
  );
  if (!valid.length) return failure();
  const days = dates(ref, zone).map((date) => {
    const records = valid.filter((r) => r.date === date);
    const merge = (key, fn) => {
      const vs = [
        ...new Set(records.map((r) => fn(r[key])).filter((v) => v !== null)),
      ];
      return vs.length === 1 ? vs[0] : null;
    };
    let max = merge("max", (v) => (finite(v) ? v : null)),
      min = merge("min", (v) => (finite(v) ? v : null));
    const cond = merge("code", condition);
    if (max !== null && min !== null && max < min) max = min = null;
    const n = [max, min, cond].filter((v) => v !== null).length;
    return {
      date,
      max: round(max),
      min: round(min),
      condition: cond,
      day_status: n === 3 ? "success" : n ? "partial" : "failure",
    };
  });
  const normalized = result(
    days,
    days.flatMap((d) => [d.max, d.min, d.condition]),
    zone,
    ref,
    fetched,
  );
  // Date placeholders remain visible without counting as valid weather.
  return {
    ...normalized,
    data: days,
    timezone: zone,
    reference_at: ref,
    fetched_at: fetched,
    expires_at: fetched + 3600000,
  };
}
export function dailyRows(raw) {
  const d = raw?.daily,
    u = raw?.daily_units;
  if (!d || !Array.isArray(d.time)) return null;
  return d.time.map((date, i) => ({
    date,
    max: u?.temperature_2m_max === "°C" ? d.temperature_2m_max?.[i] : null,
    min: u?.temperature_2m_min === "°C" ? d.temperature_2m_min?.[i] : null,
    code: d.weather_code?.[i],
  }));
}
