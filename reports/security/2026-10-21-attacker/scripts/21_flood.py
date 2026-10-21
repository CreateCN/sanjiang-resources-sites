#!/usr/bin/env python3
"""21 匿名写入面刷量：反馈/事件接口的高频写入、成功率与库体积增长。"""
import asyncio
import json
import os
import subprocess
import time
from collections import Counter

import httpx

BASE = os.environ.get("BF_BASE", "https://localhost:8603")
SITE = "https://localhost:8603"
EV = "/tmp/sj-attacker/evidence-bf"
os.makedirs(EV, exist_ok=True)
RES = {}


def note(k, v):
    RES[k] = v
    print(f"[{k}] {json.dumps(v, ensure_ascii=False)[:700]}")


def db_size():
    out = subprocess.run(["docker", "exec", "bf-app", "sh", "-c",
                          "ls -l /app/data/site.sqlite* | awk '{print $5, $9}'"],
                         capture_output=True, text=True).stdout.strip()
    return out


async def fb_burst(n, concurrency, tag="race"):
    limits = httpx.Limits(max_connections=concurrency, max_keepalive_connections=concurrency)
    async with httpx.AsyncClient(verify=False, limits=limits, timeout=20) as c:
        sem = asyncio.Semaphore(concurrency)

        async def one(i):
            async with sem:
                r = await c.post(BASE + "/api/reports/",
                                 data={"resourceId": "", "kind": "其他建议", "website": "",
                                       "title": f"{tag}-{i}",
                                       "body": "并发写入测试正文，长度足够超过十个字符。"},
                                 headers={"Origin": SITE})
                return r.status_code
        return await asyncio.gather(*[one(i) for i in range(n)])


async def event_flood(n, concurrency, tag="x"):
    limits = httpx.Limits(max_connections=concurrency, max_keepalive_connections=concurrency)
    async with httpx.AsyncClient(verify=False, limits=limits, timeout=20) as c:
        sem = asyncio.Semaphore(concurrency)

        async def one(i):
            async with sem:
                r = await c.post(BASE + "/api/event/",
                                 json={"name": "search_miss", "target": f"{tag}-{i}"},
                                 headers={"Origin": SITE})
                return r.status_code
        return await asyncio.gather(*[one(i) for i in range(n)])


def main():
    note("db_size_before", db_size())

    # A. 反馈并发竞态（全新桶）
    t0 = time.perf_counter()
    codes = asyncio.run(fb_burst(40, 40))
    note("feedback_race_fresh_bucket", {
        "counts": dict(Counter(codes)),
        "accepted": sum(1 for c in codes if c == 303),
        "blocked": sum(1 for c in codes if c == 429),
        "elapsed_s": round(time.perf_counter() - t0, 2)})

    # B. 事件接口 1500 次写入（无账号门槛）
    t0 = time.perf_counter()
    codes2 = asyncio.run(event_flood(1500, 50, tag="flood"))
    el = time.perf_counter() - t0
    note("event_flood_1500", {
        "counts": dict(Counter(codes2)),
        "accepted": sum(1 for c in codes2 if c == 200),
        "elapsed_s": round(el, 2),
        "req_per_s": round(1500 / max(el, 1e-9), 1)})

    note("db_size_after_event_flood", db_size())

    # C. 再打一轮 3000 次，观察是否出现任何限流或退化
    t0 = time.perf_counter()
    codes3 = asyncio.run(event_flood(3000, 80, tag="flood2"))
    el = time.perf_counter() - t0
    note("event_flood_3000", {
        "counts": dict(Counter(codes3)),
        "elapsed_s": round(el, 2),
        "req_per_s": round(3000 / max(el, 1e-9), 1)})
    note("db_size_after_second_flood", db_size())

    with open(EV + "/21-flood.json", "w") as f:
        json.dump(RES, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
