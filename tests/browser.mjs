import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchTestBrowser } from "./browser-harness.mjs";
import { fixtureResources as resources } from "./fixtures/content.ts";
const base = process.env.TEST_BASE_URL ?? "http://127.0.0.1:4321";
let browser;
before(async () => {
  browser = await launchTestBrowser();
});
after(async () => {
  await browser?.close();
});

test("手机和桌面实际加载响应式 WebP，原图回退地址保留", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of ['/', '/resources/zotero/', '/resources/gimp/']) {
        await page.goto(`${base}${path}`);
        const pictures = page.locator('picture');
        assert.ok(await pictures.count() > 0);
        for (const picture of await pictures.all()) {
          await picture.scrollIntoViewIfNeeded();
          const image = picture.locator('img');
          await image.evaluate(async (el) => { await el.decode(); });
          const loaded = await image.evaluate((el) => ({ current: el.currentSrc, original: el.getAttribute('src'), width: el.naturalWidth }));
          assert.match(loaded.current, /\/images\/optimized\/.*\.webp$/);
          assert.ok(loaded.original.startsWith('/images/'));
          assert.ok(!loaded.original.includes('/optimized/'));
          assert.ok(loaded.width > 0);
          assert.equal((await page.request.get(loaded.current)).status(), 200);
        }
      }
    }
  } finally { await context.close(); }
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
  assert.match(await page.locator('body').innerText(), /范围待确认/, '目录卡片显示 unknown 范围');
  assert.equal(await page.locator('link[rel="canonical"]').count(), 1);
  assert.equal(await page.locator('meta[property="og:image"]').count(), 1);
  await page.goto(`${base}/resources/zotero/`);
  assert.match(String(await page.locator("#conditions").textContent()), /适用范围待确认，请查阅资格说明/, '旧数据缺少 scope 时按 unknown 展示');
  assert.match(String(await page.locator(".checked-date").last().textContent()), /资料核对/);
  assert.match(String(await page.locator("#conditions").textContent()), /使用门槛/);
  assert.equal((await page.request.get(`${base}/robots.txt`)).status(), 200);
  assert.equal((await page.request.get(`${base}/sitemap.xml`)).status(), 200);
  await page.close();
});
test("赞助位：固定标识、外链属性、独立于资源列表、移动端无遮挡", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const origin = new URL(base).origin;
  const external = new Set();
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin) external.add(url.origin);
  });
  try {
    await page.goto(base);
    assert.equal(await page.locator('.sponsor-slot').count(), 2);
    assert.equal(await page.locator('.portal-sidebar .sponsor-sidebar').count(), 1);
    assert.equal(await page.locator('.sponsor-catalog').count(), 1);
    assert.equal(await page.locator('#resource-list .sponsor-slot').count(), 0);
    assert.equal(await page.locator('.sponsor-slot[data-resource]').count(), 0);
    assert.equal(await page.locator('#result-count').textContent(), '共 12 项');
    assert.equal(await page.locator('.sponsor-label').filter({ hasText: '广告 · 赞助' }).count(), 2);
    for (const link of await page.locator('.sponsor-link').all()) {
      assert.match(String(await link.getAttribute('rel')), /sponsored/);
      assert.match(String(await link.getAttribute('rel')), /noopener/);
      assert.match(String(await link.getAttribute('rel')), /noreferrer/);
      assert.equal(await link.getAttribute('data-outbound'), null, '赞助链接不进入资源外跳统计');
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `赞助位不得造成横向溢出（${overflow}）`);
    assert.ok(await page.locator('.portal-sidebar .sponsor-slot').isVisible());
    assert.equal(await page.locator('script[src^="http"], iframe, img[src^="http"]').count(), 0, '赞助页不加载第三方脚本、像素或图片');
    assert.deepEqual([...external], [], '首页不应产生第三方网络请求');
    await page.goto(`${base}/about/`);
    const about = String(await page.locator('body').innerText());
    assert.match(about, /赞助与广告/);
    assert.match(about, /不加载第三方脚本/);
  } finally { await context.close(); }
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

test('页脚展示实际构建提交的短哈希并链接到完整提交', async () => {
  const { resolveBuildRevision } = await import('../scripts/build-revision.mjs');
  const expected = process.env.EXPECTED_COMMIT_SHA || resolveBuildRevision();
  const page = await browser.newPage();
  try {
    await page.goto(base);
    const version = page.locator('footer [data-commit-hash]');
    assert.equal(await version.getAttribute('data-commit-hash'), expected || 'unknown');
    if (expected) {
      assert.equal(await version.locator('code').textContent(), expected.slice(0, 7));
      assert.equal(await version.locator('a').getAttribute('href'), `https://github.com/CreateCN/sanjiang-resources-sites/commit/${expected}`);
    }
  } finally { await page.close(); }
});
