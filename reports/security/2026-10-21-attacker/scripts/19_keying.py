#!/usr/bin/env python3
"""19 限流身份判定（决定性实验）：反馈与登录的桶究竟按什么键，XFF 是否可控。"""
import json
import os
import time

import httpx

DOC = "https://localhost:8643"
XFF = "https://localhost:8644"
SITE = "https://localhost:8643"
EV = "/tmp/sj-attacker/evidence-bf"
os.makedirs(EV, exist_ok=True)
RES = {}


def note(k, v):
    RES[k] = v
    print(f"[{k}] {json.dumps(v, ensure_ascii=False)[:900]}")


def fb(c, base, xff=None, title="probe"):
    h = {"Origin": SITE}
    if xff:
        h["X-Forwarded-For"] = xff
    r = c.post(base + "/api/reports/",
               data={"resourceId": "", "kind": "其他建议", "website": "",
                     "title": title, "body": "限流身份判定实验正文，长度足够超过十个字符。"},
               headers=h, timeout=20)
    return r.status_code, r.headers.get("retry-after")


def lg(c, base, user, pw, xff=None):
    h = {"Origin": SITE}
    if xff:
        h["X-Forwarded-For"] = xff
    t0 = time.perf_counter()
    r = c.post(base + "/api/login/", data={"username": user, "password": pw}, headers=h, timeout=20)
    return r.status_code, round((time.perf_counter() - t0) * 1000, 1)


def seq_run(c, label, n, fn):
    seq = [fn(i) for i in range(n)]
    return seq


def main():
    with httpx.Client(verify=False) as c:
        c.get(DOC + "/api/health/")

        # S1: 反馈桶如何分配
        s1a = seq_run(c, "doc", 6, lambda i: fb(c, DOC, None, f"doc-{i}"))
        note("S1a_documented_6_submissions", s1a)

        s1b = seq_run(c, "xff-same", 7, lambda i: fb(c, XFF, "198.51.100.5", f"x5-{i}"))
        note("S1b_xff_same_value_7_submissions", s1b)

        s1c = seq_run(c, "xff-rotate", 4, lambda i: fb(c, XFF, f"198.51.100.{20 + i}", f"xr-{i}"))
        note("S1c_xff_rotating_4_submissions", s1c)

        # S2: 账号桶是否与来源无关
        s2 = []
        for i in range(13):
            st, ms = lg(c, DOC, "xu-a", "Wrong-Password-2026")
            s2.append({"i": i + 1, "status": st, "ms": ms})
            if st == 429:
                break
        note("S2a_single_account_documented", s2)
        s2b = []
        for i in range(4):
            st, ms = lg(c, XFF, "xu-a", "Wrong-Password-2026", xff=f"198.51.100.{40 + i}")
            s2b.append({"i": i + 1, "status": st, "ms": ms})
        note("S2b_same_account_rotating_xff", s2b)
        st, ms = lg(c, XFF, "xu-b", "Acc2026!pass2", xff="198.51.100.60")
        note("S2c_control_other_account", {"status": st, "ms": ms})

    with open(EV + "/19-keying.json", "w") as f:
        json.dump(RES, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
