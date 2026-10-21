#!/usr/bin/env python3
"""08 登录限流身份取证：跨账号、跨来源、成功登录是否计入、反馈接口是否共享桶。"""
import json
import sys

sys.path.insert(0, "/media/sunhao/F/Project/sanjiang-resources-site/reports/security/2026-10-21-attacker/scripts")
from probe_client import session, record, BASE

RES = {}
CASES = [
    ("atk-admin", "Atk2026-Adm1n!x", "已锁定账号正确密码"),
    ("atk-admin2", "Adm2n-2026!x", "另一管理员正确密码"),
    ("atk-editor", "Atk2026-Edit0r!x", "编辑者正确密码"),
    ("rl-victim", "Victim-2026!x", "被实验账号正确密码"),
    ("no-such-user-zz", "Whatever-999!x", "不存在的账号"),
    ("", "", "空凭据"),
]


def note(k, v):
    RES[k] = v
    print(f"[{k}] {json.dumps(v, ensure_ascii=False)[:400]}")


def main():
    out = []
    for user, pw, label in CASES:
        s = session()
        r = s.post(BASE + "/api/login/", data={"username": user, "password": pw},
                   headers={"Origin": BASE}, allow_redirects=False, timeout=20)
        rec = {"label": label, "user": user, "status": r.status_code,
               "retry_after": r.headers.get("retry-after"),
               "location": r.headers.get("location"),
               "set_cookie": bool(r.headers.get("set-cookie"))}
        out.append(rec)
        record("throttle-login-" + (user or "empty"), "POST", "/api/login/", r,
               {"Origin": BASE}, {"username": user, "password": "<...>"})
    note("login_matrix", out)

    # 参考：编辑者会话是否仍可用（Cookie 由容器来源获取）
    cookie = open("/tmp/x2.cookie").read().strip() if __import__("os").path.exists("/tmp/x2.cookie") else ""
    note("spare_cookie", cookie[:30] + "..." if cookie else "none")

    # 反馈接口：登录桶耗尽时是否也 429
    s = session()
    r = s.post(BASE + "/api/reports/", data={"resourceId": "", "kind": "其他建议", "website": "",
                                             "title": "throttle-probe", "body": "限流身份取证正文，长度足够。"},
               headers={"Origin": BASE}, allow_redirects=False, timeout=20)
    record("throttle-feedback", "POST", "/api/reports/", r, {"Origin": BASE},
           {"title": "throttle-probe"})
    note("feedback_during_login_lock", {"status": r.status_code,
                                        "retry_after": r.headers.get("retry-after")})

    # 指标接口是否可用（非登录面）
    r = s.post(BASE + "/api/event/", json={"name": "search_miss", "target": "throttle"},
               headers={"Origin": BASE}, allow_redirects=False, timeout=20)
    note("event_during_lock", r.status_code)

    with open("/tmp/sj-attacker/evidence/08-throttle-summary.json", "w") as f:
        json.dump(RES, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
