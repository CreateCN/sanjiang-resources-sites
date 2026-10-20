import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resources, categories } from "../src/data/resources.ts";

test("资源 ID 唯一且可用于稳定路由", () => {
  assert.equal(new Set(resources.map((r) => r.id)).size, resources.length);
  for (const r of resources) assert.match(r.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
});
test("每条资源均有可解释的费用、资格和官方来源", () => {
  for (const r of resources) {
    for (const field of [
      "title",
      "summary",
      "cost",
      "license",
      "eligibility",
      "caveat",
    ])
      assert.ok(r[field]?.trim(), `${r.id}: ${field}`);
    assert.ok(categories.some((c) => c.id !== "all" && c.id === r.category));
    for (const url of [r.url, r.sourceUrl])
      assert.equal(new URL(url).protocol, "https:");
    assert.equal(r.steps.length, 3);
  }
});
test("核验状态与日期一致，未核验资源不伪造日期", () => {
  for (const r of resources) {
    if (r.status === "verified")
      assert.match(r.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
    else assert.equal(r.checkedAt, null);
  }
});
test("所有图片都有本地素材及描述", () => {
  for (const r of resources.filter((r) => r.image)) {
    assert.ok(
      existsSync(new URL(`../public${r.image}`, import.meta.url)),
      r.image,
    );
    assert.ok(r.imageAlt);
  }
  assert.ok(
    existsSync(new URL("../public/images/CREDITS.md", import.meta.url)),
  );
});
