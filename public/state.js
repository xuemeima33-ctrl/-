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
export function nextMidnight(time, zone) {
  const day = localDate(time, zone);
  let low = time,
    high = time + 36 * 3600000;
  while (high - low > 1) {
    const mid = Math.floor((high + low) / 2);
    if (localDate(mid, zone) === day) low = mid;
    else high = mid;
  }
  return high;
}
export function retrySeconds(value, now = Date.now()) {
  let n;
  if (typeof value === "string" && /^\d+$/.test(value)) n = Number(value);
  else if (typeof value === "number") n = value;
  else if (typeof value === "string")
    n = Math.ceil((Date.parse(value) - now) / 1000);
  return Number.isFinite(n) && n > 0 ? Math.min(3600, Math.ceil(n)) : 30;
}
export class Versions {
  constructor() {
    this.n = 0;
    this.controller = null;
  }
  start() {
    this.controller?.abort();
    this.controller = new AbortController();
    return { version: ++this.n, signal: this.controller.signal };
  }
  valid(n) {
    return this.n === n;
  }
  cancel() {
    this.controller?.abort();
    this.n++;
  }
}
