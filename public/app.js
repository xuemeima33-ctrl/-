import { localDate, nextMidnight, retrySeconds, Versions } from "./state.js";
const $ = (id) => document.getElementById(id);
const searchVersions = new Versions(),
  weatherVersions = new Versions();
let city = null,
  blocks = { current: null, forecast: null },
  snapshots = {},
  busy = false,
  searchBusy = "",
  cooldown = 0,
  serverBase = null,
  perfBase = 0,
  wallBase = 0,
  lastDay = null,
  autoDay = null,
  midnightTimer;
const now = () =>
  serverBase === null
    ? Date.now()
    : serverBase +
      Math.max(performance.now() - perfBase, Date.now() - wallBase);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const val = (v, unit = "") =>
  v === null || v === undefined ? "--" : esc(v) + unit;
const message = {
  invalid_query: "请输入 1–100 个字符的城市名称。",
  timeout: "请求超时，请重试。",
  rate_limited: "请求较多，请稍后重试。",
  quota_exhausted: "天气服务请求额度暂不可用，请稍后重试。",
  stale_data: "当前天气已过期，请刷新。",
  invalid_data: "天气数据暂不可用，请重试。",
  unavailable: "服务暂不可用，请重试。",
};
const textError = (e) => message[e?.error_code] || "服务暂不可用，请重试。";
function cool(value) {
  cooldown = Math.max(
    cooldown,
    performance.now() + retrySeconds(value, now()) * 1000,
  );
}
function timeLabel(t) {
  if (!t || !city) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: city.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).format(t);
}
async function api(path, signal) {
  const c = new AbortController(),
    abort = () => c.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 10000);
  try {
    const r = await fetch(path, { signal: c.signal, cache: "no-store" });
    const data = await r.json();
    if (r.status === 429) {
      cool(data.retry_after || r.headers.get("Retry-After"));
    }
    if (!r.ok) throw data;
    return data;
  } catch (e) {
    if (c.signal.aborted && !signal.aborted) throw { error_code: "timeout" };
    throw e;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
function renderButtons() {
  const waiting = performance.now() < cooldown;
  const left = Math.ceil((cooldown - performance.now()) / 1000);
  $("refresh").disabled = busy || waiting;
  document
    .querySelectorAll("[data-retry]")
    .forEach((b) => (b.disabled = busy || waiting));
  $("search-button").disabled = !!searchBusy || waiting;
  if (waiting) {
    $("weather-status").textContent = `请求较多，请在 ${left} 秒后重试。`;
    $("search-status").textContent = `请求较多，请在 ${left} 秒后重试。`;
  }
}
function render() {
  if (!city) return;
  const loading = busy ? "正在更新天气，以下保留上次数据。" : null;
  const successes = Object.values(blocks).filter(
    (b) => b?.status === "success",
  ).length;
  const state = busy
    ? "loading"
    : successes === 2
      ? "ready"
      : successes === 1
        ? "partial"
        : "error";
  $("weather").dataset.state = state;
  $("weather-status").textContent =
    loading ||
    {
      ready: "天气已更新",
      partial: "部分天气获取失败，可重试对应区块。",
      error: "天气获取失败，请重试。",
    }[state];
  for (const name of ["current", "forecast"]) {
    const b = blocks[name],
      snapshot = snapshots[name];
    const data =
      b?.status === "success"
        ? b
        : snapshot || (name === "forecast" && b?.data ? b : null);
    const history = b?.status !== "success" && !!snapshot;
    const incomplete = b?.status === "success" && b.completeness !== "complete";
    let note = busy
      ? "正在更新，请稍候。"
      : b?.status === "failure"
        ? textError(b)
        : incomplete
          ? "部分字段暂无数据，以 -- 标记。"
          : "";
    if (history)
      note +=
        name === "current"
          ? ` 历史数据${now() - snapshot.updated_at > 900000 ? "，已过期" : ""}；观测时间 ${timeLabel(snapshot.updated_at)}。`
          : ` 旧日期范围，更新失败；${snapshot.data[0].date} 至 ${snapshot.data[4].date}，取数时间 ${timeLabel(snapshot.fetched_at)}。`;
    const retry =
      !busy && (!b || b.status === "failure" || incomplete)
        ? `<button class="retry" type="button" data-retry="${name}">重试${name === "current" ? "当前天气" : "预报"}</button>`
        : "";
    const notice = note
      ? `<p class="notice" role="status">${esc(note)}</p>`
      : "";
    if (name === "current") {
      const d = data?.data || {};
      const metrics = [
        ["温度", d.temperature, "°C"],
        ["体感温度", d.feels_like, "°C"],
        ["天气状况", d.condition, ""],
        ["湿度", d.humidity, "%"],
        ["风速", d.wind_speed, "m/s"],
      ];
      $("current").innerHTML =
        `<section class="weather-card ${history ? "historical" : ""}" aria-label="当前天气"><div class="section-head"><h3>${history ? "历史天气快照" : "当前天气"}</h3><span class="tag">${busy ? "UPDATING" : history ? "HISTORY" : "CURRENT"}</span></div>${notice}<dl class="metrics">${metrics.map(([label, v, u]) => `<div class="metric"><dt>${label}</dt><dd>${val(v)}${v !== undefined && v !== null ? `<span class="unit">${u}</span>` : ""}</dd></div>`).join("")}</dl><p class="muted">当地数据时间 ${data ? esc(timeLabel(data.updated_at)) : "--"} · ${esc(city.timezone)}</p>${retry}</section>`;
    } else {
      $("forecast").innerHTML =
        `<section class="forecast-section ${history ? "historical" : ""}" aria-label="五日预报"><div class="section-head"><div><h3>${history ? "旧日期范围 · 历史预报" : "未来 5 日"}</h3><p class="muted">城市当地日期${data ? ` · 查询基准 ${esc(timeLabel(data.reference_at))}` : ""}</p></div><span class="tag">5-DAY FORECAST</span></div>${notice}<div class="forecast-grid">${data ? data.data.map((d) => `<article class="day"><p class="day-date">${esc(d.date)}<br>${esc(new Intl.DateTimeFormat("zh-CN", { weekday: "long", timeZone: "UTC" }).format(new Date(d.date + "T12:00Z")))}</p><div class="day-symbol" aria-hidden="true">${d.condition === "晴" ? "☀" : d.condition?.includes("雨") ? "☂" : "☁"}</div><p class="day-condition">${d.day_status === "failure" ? "该日预报获取失败" : val(d.condition)}</p><p class="temps">${val(d.max, "°")}<span> / ${val(d.min, "°")}</span></p></article>`).join("") : '<p class="muted">暂无预报数据</p>'}</div>${data ? `<p class="muted">取数时间 ${esc(timeLabel(data.fetched_at))}</p>` : ""}${retry}</section>`;
    }
  }
  renderButtons();
}
function schedule() {
  clearTimeout(midnightTimer);
  if (!city || serverBase === null) return;
  midnightTimer = setTimeout(
    () => checkClock(),
    Math.max(1, nextMidnight(now(), city.timezone) - now() + 50),
  );
}
function checkClock() {
  if (!city || serverBase === null) return;
  const day = localDate(now(), city.timezone);
  if (day !== lastDay && autoDay !== day && !busy) {
    autoDay = day;
    loadWeather("both", true);
    return;
  }
  const c = blocks.current;
  if (c?.status === "success" && now() - c.updated_at > 900000) {
    blocks.current = {
      status: "failure",
      completeness: "none",
      error_code: "stale_data",
    };
    render();
  }
  if (!midnightTimer) schedule();
}
async function loadWeather(module = "both", automatic = false) {
  if (!city) return;
  if (performance.now() < cooldown && !automatic) return;
  if (serverBase !== null && lastDay !== localDate(now(), city.timezone))
    module = "both";
  const request = weatherVersions.start(),
    selected = city;
  busy = true;
  render();
  const oldDay = lastDay;
  try {
    const data = await api(
      "/api/weather?" +
        new URLSearchParams({ city_key: selected.city_key, module }),
      request.signal,
    );
    if (!weatherVersions.valid(request.version)) return;
    serverBase = data.server_at;
    perfBase = performance.now();
    wallBase = Date.now();
    lastDay = localDate(data.reference_at, selected.timezone);
    autoDay = lastDay;
    for (const name of ["current", "forecast"])
      if (data[name]) {
        blocks[name] = data[name];
        if (data[name].status === "success") snapshots[name] = data[name];
        if (data[name].retry_after) cool(data[name].retry_after);
      }
    $("demo-notice").hidden = !data.demo;
    $("demo-label").textContent = data.demo ? "· 演示数据（非实时天气）" : "";
  } catch (e) {
    if (!weatherVersions.valid(request.version)) return;
    for (const name of module === "both" ? ["current", "forecast"] : [module])
      blocks[name] = {
        status: "failure",
        completeness: "none",
        error_code: e.error_code || "unavailable",
      };
    if (automatic) {
      autoDay = localDate(now(), city.timezone);
      lastDay = oldDay;
    }
  } finally {
    if (weatherVersions.valid(request.version)) {
      busy = false;
      render();
      schedule();
    }
  }
}
function selectCity(next) {
  const same = city?.city_key === next.city_key;
  weatherVersions.cancel();
  busy = false;
  clearTimeout(midnightTimer);
  if (!same) {
    blocks = { current: null, forecast: null };
    snapshots = {};
    lastDay = null;
    autoDay = null;
    serverBase = null;
  }
  city = next;
  $("weather").hidden = false;
  $("welcome").hidden = true;
  $("city-label").textContent = [city.name, city.admin, city.country]
    .filter(Boolean)
    .join(" · ");
  $("city-zone").textContent =
    `${city.timezone} · ${city.latitude}, ${city.longitude}`;
  render();
  loadWeather();
}
$("query").addEventListener("input", () => {
  searchVersions.cancel();
  searchBusy = "";
  $("candidates").replaceChildren();
  $("search-status").textContent =
    "输入已修改，请重新搜索；下方天气仍属于已选城市。";
  renderButtons();
});
$("search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("query").value.trim();
  if (!q || [...q].length > 100) {
    $("search-status").textContent = !q
      ? "请输入城市名称。"
      : "最多 100 个字符。";
    return;
  }
  if (searchBusy === q || performance.now() < cooldown) return;
  const request = searchVersions.start();
  searchBusy = q;
  $("search-status").textContent = "正在搜索城市…";
  $("candidates").replaceChildren();
  renderButtons();
  try {
    const data = await api(
      "/api/search?" + new URLSearchParams({ q }),
      request.signal,
    );
    if (!searchVersions.valid(request.version)) return;
    if (!Array.isArray(data.candidates)) throw { error_code: "invalid_data" };
    const candidates = data.candidates;
    const n = candidates.filter((c) => c.selectable).length;
    $("search-status").textContent = !candidates.length
      ? "未找到匹配城市，请修改名称。"
      : !n
        ? "暂无可选择城市，请补充城市名称。"
        : `找到 ${candidates.length} 个候选，请选择城市。`;
    for (const c of candidates) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "candidate";
      button.disabled = !c.selectable;
      const title = document.createElement("span");
      title.textContent = [c.name || "未命名", c.admin, c.country || "国家缺失"]
        .filter(Boolean)
        .join(" · ");
      const small = document.createElement("small");
      small.textContent = `${c.latitude ?? "--"}, ${c.longitude ?? "--"} · ${c.timezone || "时区缺失"}`;
      button.append(title, small);
      button.addEventListener("click", () => selectCity(c));
      $("candidates").append(button);
    }
    $("candidates").querySelector("button:not(:disabled)")?.focus();
  } catch (e) {
    if (searchVersions.valid(request.version))
      $("search-status").textContent = `城市搜索失败。${textError(e)}`;
  } finally {
    if (searchVersions.valid(request.version)) {
      searchBusy = "";
      renderButtons();
    }
  }
});
$("refresh").addEventListener("click", () => loadWeather());
$("weather").addEventListener("click", (e) => {
  const b = e.target.closest("[data-retry]");
  if (b) loadWeather(b.dataset.retry);
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    const changed =
      city &&
      serverBase !== null &&
      localDate(now(), city.timezone) !== lastDay;
    checkClock();
    schedule();
    if (changed)
      $("weather-status").textContent =
        "页面暂停期间未及时更新，正在刷新天气。";
  }
});
window.addEventListener("pageshow", () => {
  checkClock();
  schedule();
});
window.addEventListener("focus", checkClock);
setInterval(() => {
  checkClock();
  renderButtons();
}, 1000);
