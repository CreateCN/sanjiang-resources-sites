#!/usr/bin/env python3
"""20 并发竞态：同一账号并发登录、同一来源并发反馈，检查计数器是否存在竞态绕过。"""
import asyncio
import json
import os
from collections import Counter

import httpx

DOC = "https://localhost:8643"
SITE = "https://localhost:8643"
EV = "/tmp/sj-attacker/evidence-bf"
os.makedirs(EV, exist_ok=True)
RES = {}


def note(k, v):
    RES[k] = v
    print(f"[{k}] {json.dumps(v, ensure_ascii=False)[:700]}")


async def login_burst(user, pw, n, concurrency):
    limits = httpx.Limits(max_connections=concurrency, max_keepalive_connections=concurrency)
    async with httpx.AsyncClient(verify=False, limits=limits, timeout=20) as c:
        sem = asyncio.Semaphore(concurrency)

        async def one(i):
            async with sem:
                r = await c.post(DOC + "/api/login/",
                                 data={"username": user, "password": pw},
                                 headers={"Origin": SITE})
                return r.status_code

        return await asyncio.gather(*[one(i) for i in range(n)])


async def fb_burst(n, concurrency):
    limits = httpx.Limits(max_connections=concurrency, max_keepalive_connections=concurrency)
    async with httpx.AsyncClient(verify=False, limits=limits, timeout=20) as c:
        sem = asyncio.Semaphore(concurrency)

        async def one(i):
            async with sem:
                r = await c.post(DOC + "/api/reports/",
                                 data={"resourceId": "", "kind": "其他建议", "website": "",
                                       "title": f"race-{i}",
                                       "body": "并发竞态测试正文，长度足够超过十个字符。"},
                                 headers={"Origin": SITE})
                return r.status_code

        return await asyncio.gather(*[one(i) for i in range(n)])


def main():
    # A. 同一账号 40 并发登录（正确口令，预期最多 10 次通过计数）
    codes = asyncio.run(login_burst("xu-c", "Acc2026!pass3", 40, 40))
    note("login_race_40_concurrent", {"counts": dict(Counter(codes)),
                                      "allowed": sum(1 for c in codes if c == 303),
                                      "blocked": sum(1 for c in codes if c == 429)})
    # B. 同一来源 40 并发反馈
    codes2 = asyncio.run(fb_burst(40, 40))
    note("feedback_race_40_concurrent", {"counts": dict(Counter(codes2)),
                                         "accepted": sum(1 for c in codes2 if c == 303),
                                         "blocked": sum(1 for c in codes2 if c == 429)})
    # C. 再补一轮，观察是否有残留额度
    codes3 = asyncio.run(fb_burst(10, 10))
    note("feedback_race_second_round", {"counts": dict(Counter(codes3))})

    with open(EV + "/20-race.json", "w") as f:
        json.dump(RES, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
