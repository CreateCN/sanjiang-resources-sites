#!/usr/bin/env python3
"""23 修复验证：按访客限流、成功登录不扣额度、真实 Retry-After、指标目标校验、响应头。

目标实例：v2-app / v2-nginx（8803 生产形态：XFF 覆盖为单值；8804 追加形态：多值链）。
"""
import json
import os
import subprocess

import httpx

DOC = "https://localhost:8803"
APPEND = "https://localhost:8804"
SITE = "https://localhost:8803"
EV = "/tmp/sj-attacker/evidence-bf"
os.makedirs(EV, exist_ok=True)
RES = {}


def note(k, v):
    RES[k] = v
    print(f"[{k}] {json.dumps(v, ensure_ascii=False)[:800]}")


def login(c, user, pw, base=DOC, headers=None):
    r = c.post(base + "/api/login/", data={"username": user, "password": pw},
               headers={"Origin": SITE, **(headers or {})})
    return r.status_code, r.headers.get("retry-after")


def container_login(container, user, pw):
    out = subprocess.run(
        ["docker", "exec", container, "curl", "-sk", "-o", "/dev/null", "-D", "-", "-w", "\nCODE:%{http_code}",
         "-X", "POST", "https://v2-nginx:8803/api/login/", "-H", f"Origin: {SITE}",
         "--data-urlencode", f"username={user}", "--data-urlencode", f"password={pw}"],
        capture_output=True, text=True).stdout
    code = out.rsplit("CODE:", 1)[-1].strip()
    retry = next((l.split(":", 1)[1].strip() for l in out.splitlines() if l.lower().startswith("retry-after")), None)
    return code, retry


def container_feedback(container):
    out = subprocess.run(
        ["docker", "exec", container, "curl", "-sk", "-o", "/dev/null", "-w", "%{http_code}",
         "-X", "POST", "https://v2-nginx:8803/api/reports/", "-H", f"Origin: {SITE}",
         "--data-urlencode", "resourceId=", "--data-urlencode", "kind=其他建议",
         "--data-urlencode", "website=", "--data-urlencode", "title=from-container",
         "--data-urlencode", "body=来自独立容器的反馈正文，长度足够超过十个字符。"],
        capture_output=True, text=True).stdout.strip()
    return out


def main():
    with httpx.Client(verify=False, timeout=20) as c:
        c.get(DOC + "/api/health/")

        # 1) 成功登录不消耗额度
        successes = [login(c, "v2-admin", "V2-Admin-2026!x")[0] for _ in range(20)]
        note("successful_logins_20x", {"statuses": sorted(set(successes)), "all_303": all(s == 303 for s in successes)})

        # 2) 失败才计数：同一账号 10 次失败后 429，并给出真实 Retry-After
        fail_seq = [login(c, "v2-victim", "wrong-password") for _ in range(11)]
        note("failure_sequence_victim", {
            "statuses": [s for s, _ in fail_seq],
            "blocked_at": next((i + 1 for i, (s, _) in enumerate(fail_seq) if s == 429), None),
            "retry_after": fail_seq[-1][1],
        })

        # 3) 账号桶隔离：同来源、别的账号仍可正常登录
        note("other_account_same_client", login(c, "v2-admin", "V2-Admin-2026!x")[0])

        # 4) 打满客户端桶（30 次失败，分散到 3 个用户名）
        for name in ("ghost-a", "ghost-b", "ghost-c"):
            for _ in range(10):
                login(c, name, "wrong-password")
        exhausted = login(c, "ghost-d", "wrong-password")
        note("client_bucket_exhausted", {"status": exhausted[0], "retry_after": exhausted[1]})

        # 5) 伪造 XFF 不能刷新额度（生产形态会覆盖成真实来源）
        spoofed = login(c, "ghost-e", "wrong-password", headers={"X-Forwarded-For": "203.0.113.99"})
        note("spoofed_xff_same_client", {"status": spoofed[0], "retry_after": spoofed[1]})

        # 6) 独立来源不受影响（按访客分桶的关键证据）
        note("independent_source_login", dict(zip(("status", "retry_after"),
                                                 container_login("bf-nginx", "v2-admin", "V2-Admin-2026!x"))))

        # 7) 反馈：每客户端 5 次/小时，Retry-After 反映 1 小时窗口
        fb = []
        for i in range(6):
            r = c.post(DOC + "/api/reports/", data={"resourceId": "", "kind": "其他建议", "website": "",
                                                    "title": f"verify-{i}",
                                                    "body": "修复验证用的反馈正文，长度足够超过十个字符。"},
                       headers={"Origin": SITE})
            fb.append({"i": i + 1, "status": r.status_code, "retry": r.headers.get("retry-after")})
        note("feedback_budget", {"seq": fb,
                                 "blocked_at": next((x["i"] for x in fb if x["status"] == 429), None),
                                 "retry_after_s": fb[-1]["retry"]})
        note("feedback_independent_source", {"status": container_feedback("bf-nginx")})

        # 8) 指标：未知目标静默丢弃，已发布目标正常计数
        unknown = c.post(DOC + "/api/event/", json={"name": "resource_view", "target": "no-such-resource"},
                         headers={"Origin": SITE})
        known = c.post(DOC + "/api/event/", json={"name": "resource_view", "target": "gimp"},
                       headers={"Origin": SITE})
        junk = c.post(DOC + "/api/event/", json={"name": "guide_view", "target": "../../etc/passwd"},
                      headers={"Origin": SITE})
        note("event_target_validation", {"unknown": unknown.status_code, "known": known.status_code,
                                         "path_traversal_target": junk.status_code})

        # 9) 响应头
        r = c.get(DOC + "/")
        note("security_headers", {k: r.headers.get(k) for k in
                                  ("content-security-policy-report-only", "strict-transport-security",
                                   "permissions-policy", "cross-origin-opener-policy", "x-frame-options")})

    # 10) 限流身份键分布（应出现多个客户端 IP）
    dump = subprocess.run(["docker", "exec", "v2-app", "node", "-e", """
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('/app/data/site.sqlite');
const rows=db.prepare("SELECT key,count FROM rate_limits WHERE key LIKE 'login-client:%' OR key LIKE 'reports-client:%'").all();
console.log(JSON.stringify(rows));
"""], capture_output=True, text=True).stdout.strip()
    note("client_identity_keys", json.loads(dump or "[]"))

    with open(EV + "/23-fix-verification.json", "w") as f:
        json.dump(RES, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
