import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { resources } from "../src/data/resources.ts";
const base = process.env.TEST_BASE_URL ?? "http://127.0.0.1:4321";
let browser;
before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
});
after(async () => {
  await browser?.close();
});

test("首页、搜索、分类、空结果及可分享网址", async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  assert.equal(
    await page.locator("[data-resource]:visible").count(),
    resources.length,
  );
  await page.locator("#search").fill("Python");
  assert.equal(await page.locator("[data-resource]:visible").count(), 1);
  assert.equal(new URL(page.url()).searchParams.get("q"), "Python");
  await page.reload();
  assert.equal(await page.locator("#search").inputValue(), "Python");
  assert.equal(await page.locator("[data-resource]:visible").count(), 1);
  await page.locator("#search").fill("没有这个资源xyz");
  assert.ok(await page.locator("#empty-state").isVisible());
  await page.locator("#reset-search").click();
  assert.equal(
    await page.locator("[data-resource]:visible").count(),
    resources.length,
  );
  await page.locator('.filter-button[data-category="design"]').click();
  assert.equal(
    await page.locator("[data-resource]:visible").count(),
    resources.filter((r) => r.category === "design").length,
  );
  assert.equal(
    await page
      .locator('.filter-button[data-category="design"]')
      .getAttribute("aria-pressed"),
    "true",
  );
  await page.goto(`${base}/?category=invalid&q=%20%20`);
  assert.equal(
    await page.locator("[data-resource]:visible").count(),
    resources.length,
  );
  assert.deepEqual(errors, []);
  await page.close();
});
test("公开页包含 canonical、OG 与时效说明", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  assert.equal(await page.locator('link[rel="canonical"]').count(), 1);
  assert.equal(await page.locator('meta[property="og:image"]').count(), 1);
  await page.goto(`${base}/resources/zotero/`);
  assert.match(String(await page.locator(".checked-date").last().textContent()), /资料核对/);
  assert.match(String(await page.locator("#conditions").textContent()), /使用门槛/);
  assert.equal((await page.request.get(`${base}/robots.txt`)).status(), 200);
  assert.equal((await page.request.get(`${base}/sitemap.xml`)).status(), 200);
  await page.close();
});
test("全部详情路由与官方链接，所有图片正常加载", async () => {
  const page = await browser.newPage();
  for (const resource of resources) {
    const response = await page.goto(`${base}/resources/${resource.id}/`);
    assert.equal(response.status(), 200);
    assert.equal(await page.locator("h1").textContent(), resource.title);
    assert.equal(
      await page
        .getByRole("link", { name: "前往官方资源" })
        .getAttribute("href"),
      resource.url,
    );
    assert.equal(await page.locator("#start li").count(), 3);
    const feedback = await page.locator("#report .portal-button").getAttribute("href");
    assert.ok(feedback.includes(resource.id));
  }
  await page.goto(base);
  await page
    .locator("img")
    .evaluateAll((images) =>
      images.forEach((image) => (image.loading = "eager")),
    );
  await page.waitForFunction(() =>
    [...document.images].every((image) => image.complete),
  );
  assert.equal(
    await page
      .locator("img")
      .evaluateAll(
        (images) => images.filter((image) => !image.naturalWidth).length,
      ),
    0,
  );
  await page.close();
});
test("反馈页预选资源、站内提交且带蜜罐字段", async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/feedback/?resource=zotero`);
  assert.equal(await page.locator("#feedback-resource").inputValue(), "zotero");
  assert.equal(
    await page.locator("form").first().getAttribute("action"),
    "/api/reports/",
  );
  assert.equal(await page.locator("form").first().getAttribute("method"), "post");
  assert.equal(await page.locator("#website").count(), 1);
  await page.close();
});
test("无 JavaScript 仍可浏览详情并使用原生反馈表单", async () => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(base);
  assert.equal(
    await page.locator("[data-resource]:visible").count(),
    resources.length,
  );
  await page.locator("h3 a").first().click();
  assert.ok(await page.locator("#conditions").isVisible());
  await page.goto(`${base}/feedback/`);
  assert.equal(await page.locator("form").first().getAttribute("method"), "post");
  assert.equal(
    await page.locator("form").first().getAttribute("action"),
    "/api/reports/",
  );
  await context.close();
});
test("320/390/768/1440 宽度无横向溢出，手机核心流程与减少动态效果", async () => {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of [
      "/",
      "/resources/zotero/",
      "/resources/github-education/",
      "/guides/",
      "/scenarios/writing/",
      "/about/",
      "/feedback/",
    ]) {
      await page.goto(`${base}${path}`);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        `${path} at ${width}px`,
      );
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await page.locator("#search").fill("文献");
  await page.locator("h3 a:visible").first().click();
  await page.locator("#report .portal-button").click();
  assert.ok(page.url().includes("resource=zotero"));
  await page.close();
});
test("键盘跳过导航、焦点可见与404恢复入口", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(":focus").textContent(), "跳到主要内容");
  const outline = await page
    .locator(":focus")
    .evaluate((el) => getComputedStyle(el).outlineStyle);
  assert.notEqual(outline, "none");
  const response = await page.goto(`${base}/does-not-exist/`);
  assert.equal(response.status(), 404);
  assert.ok(await page.getByRole("link", { name: "浏览资源目录" }).isVisible());
  await page.close();
});
