import { test, expect } from "@playwright/test";
async function choose(page, name = "北京") {
  await page.getByLabel("你想了解哪座城市？").fill(name);
  await page.getByRole("button", { name: "搜索城市" }).click();
  await page.locator(".candidate").first().click();
  await expect(page.locator("#weather")).toHaveAttribute("data-state", "ready");
}
for (const width of [320, 375, 768, 1440])
  test(`AC05-02 complete flow and no overflow at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    await choose(page);
    await expect(page.locator(".day")).toHaveCount(5);
    await expect(page.locator(".metric")).toHaveCount(5);
    if (width === 1440 || width === 375)
      await page.screenshot({
        path: `/tmp/weather-site-${width}.png`,
        fullPage: true,
      });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "刷新天气" }).click();
    await expect(page.locator("#weather")).toHaveAttribute(
      "data-state",
      "ready",
    );
  });
test("AC01-02 explicit ambiguous selection and safe input rendering", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("你想了解哪座城市？").fill("Springfield");
  await page.getByRole("button", { name: "搜索城市" }).click();
  await expect(page.locator(".candidate")).toHaveCount(2);
  await expect(page.locator("#weather")).toBeHidden();
  await page.locator(".candidate").nth(1).click();
  await expect(page.locator("#city-label")).toContainText("Illinois");
  await page.getByLabel("你想了解哪座城市？").fill("<script>alert(1)</script>");
  await expect(page.locator("#city-label")).toContainText("Illinois");
});
test("AC04-03 city A late response cannot overwrite city B", async ({
  page,
}) => {
  await page.goto("/");
  let release;
  let requests = 0;
  await page.route("**/api/weather?*", async (route) => {
    requests++;
    if (requests === 1) await new Promise((r) => (release = r));
    await route.continue().catch(() => {});
  });
  await page.getByLabel("你想了解哪座城市？").fill("北京");
  await page.getByRole("button", { name: "搜索城市" }).click();
  await page.locator(".candidate").first().click();
  await expect.poll(() => requests).toBe(1);
  await page.getByLabel("你想了解哪座城市？").fill("东京");
  await page.getByRole("button", { name: "搜索城市" }).click();
  await page.locator(".candidate").first().click();
  await expect(page.locator("#weather")).toHaveAttribute("data-state", "ready");
  release();
  await expect(page.locator("#city-label")).toContainText("东京");
  await expect(page.locator("#city-zone")).toContainText("Asia/Tokyo");
});
test("AC04-06 failed refresh preserves labeled history and retries", async ({
  page,
}) => {
  await page.goto("/");
  await choose(page);
  await page.route("**/api/weather?*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error_code: "unavailable" }),
    }),
  );
  await page.getByRole("button", { name: "刷新天气" }).click();
  await expect(page.locator("#weather")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#current")).toContainText("历史数据");
  await expect(page.locator("#forecast")).toContainText("旧日期范围");
  await expect(page.locator(".day")).toHaveCount(5);
  await page.unroute("**/api/weather?*");
  await page.getByRole("button", { name: "重试当前天气" }).click();
  await expect(page.locator("#weather")).toHaveAttribute(
    "data-state",
    "partial",
  );
});
test("AC04-05 local midnight refresh exactly once and changes date range", async ({
  page,
}) => {
  const start = Date.parse("2026-10-16T15:59:50Z");
  await page.clock.install({ time: start });
  let count = 0;
  await page.route("**/api/weather?*", async (route) => {
    count++;
    const r = await route.fetch();
    const data = await r.json();
    const reference = start + (count === 1 ? 0 : 11000);
    data.reference_at = data.server_at = reference;
    for (const key of ["current", "forecast"])
      if (data[key]) {
        data[key].reference_at = reference;
        data[key].fetched_at = reference;
        if (key === "current") data[key].updated_at = reference;
        else
          data[key].data.forEach(
            (d, i) => (d.date = `2026-10-${17 + (count === 1 ? 0 : 1) + i}`),
          );
      }
    await route.fulfill({ response: r, json: data });
  });
  await page.goto("/");
  await choose(page);
  await expect(page.locator(".day-date").first()).toContainText("2026-10-17");
  await page.clock.runFor(11000);
  await expect.poll(() => count).toBe(2);
  await expect(page.locator(".day-date").first()).toContainText("2026-10-18");
  await page.clock.runFor(60000);
  expect(count).toBe(2);
});
test("AC02-03 visible current snapshot expires after 15 minutes", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/");
  await choose(page);
  await page.clock.runFor(901000);
  await expect(page.locator("#current")).toContainText("历史数据，已过期");
  await expect(page.locator("#weather")).toHaveAttribute(
    "data-state",
    "partial",
  );
});
