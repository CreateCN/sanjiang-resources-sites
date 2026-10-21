#!/usr/bin/env python3
"""09 限流身份模型：在干净实例上精确计数，判断桶是「按来源」还是「全局共享」。"""
import json
import re
import subprocess
import sys

sys.path.insert(0, "/media/sunhao/F/Project/sanjiang-resources-site/reports/security/2026-10-21-attacker/scripts")
from probe_client import session, record

BASES = {"doc": "https://localhost:8453", "no-xff": "https://localhost:8454"}
RES = {}


def note(k, v):
    RES[k] = v
    print(f"[{k}] {json.dumps(v, ensure_ascii=False)[:800]}")


def login(base, user, pw):
    s = session()
    r = s.post(base + "/api/login/", data={"username": user, "password": pw},
               headers={"Origin": "https://localhost:8453"}, allow_redirects=False, timeout=20)
    return r


def from_container(container, base, user, pw):
    """从独立容器（不同 TCP 源地址）发起一次登录，返回状态码。"""
    out = subprocess.run(
        ["docker", "exec", container, "curl", "-sk", "-o", "/dev/null", "-D", "-", "-w", "\nCODE:%{http_code}", "-X", "POST", base.replace("localhost", "sanjiang-atk2-nginx") + "/api/login/",
         "-H", "Origin: https://localhost:8453",
         "--data-urlencode", f"username={user}", "--data-urlencode", f"password={pw}"],
        capture_output=True, text=True)
    body = out.stdout
    m = re.search(r"CODE:(\d{3})", body)
    code = m.group(1) if m else "?"
    retry = ""
    for line in body.splitlines():
        if line.lower().startswith("retry-after"):
            retry = line.strip()
    return code, retry


def main():
    base = BASES["doc"]
    seq = []
    # 交替使用两个不同账号，从同一来源连续尝试；记录每一次状态
    for i in range(16):
        user, pw = ("ctl-a", "A2026!ctlpass1") if i % 2 == 0 else ("ctl-b", "B2026!ctlpass2")
        r = login(base, user, pw)
        seq.append({"i": i + 1, "user": user, "status": r.status_code,
                    "retry": r.headers.get("retry-after")})
        if r.status_code == 429:
            break
    note("doc_config_sequence", seq)
    total = len(seq)

    # 独立来源（容器）在同一实例、同一代理配置下尝试另一个账号
    c_code, c_retry = from_container("sj-probe", base, "ctl-c", "C2026!ctlpass3")
    note("independent_source_same_config", {"status": c_code, "retry": c_retry})

    # 无 XFF 的对照代理
    r = login(BASES["no-xff"], "ctl-c", "C2026!ctlpass3")
    note("no_xff_proxy_same_source", {"status": r.status_code, "retry": r.headers.get("retry-after")})
    c2 = from_container("sj-probe2", BASES["no-xff"], "ctl-c", "C2026!ctlpass3")
    note("no_xff_proxy_independent_source", {"status": c2[0], "retry": c2[1]})

    note("total_attempts_before_lock", total)
    with open("/tmp/sj-attacker/evidence/09-ratelimit-summary.json", "w") as f:
        json.dump(RES, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
