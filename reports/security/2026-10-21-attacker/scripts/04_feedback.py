#!/usr/bin/env python3
"""04 匿名反馈：输入校验、存储型注入、蜜罐、回执、限流键与跨来源影响。"""
import json
import re
import sys
import time

sys.path.insert(0, "/media/sunhao/F/Project/sanjiang-resources-site/reports/security/2026-10-21-attacker/scripts")
from probe_client import session, req, BASE, record

ADMIN = ("atk-admin", "Atk2026-Adm1n!x")
RES = {}


def note(k, v):
    RES[k] = v
    print(f"[{k}] {json.dumps(v, ensure_ascii=False)[:500]}")


def admin():
    s = session()
    r = s.post(BASE + "/api/login/", data={"username": ADMIN[0], "password": ADMIN[1]},
               headers={"Origin": BASE}, allow_redirects=False, timeout=20)
    return s


def submit(s, payload, tag, origin=BASE, base=None):
    b = base or BASE
    r = s.post(b + "/api/reports/", data=payload, headers={"Origin": origin},
               allow_redirects=False, timeout=20)
    record("feedback-" + tag, "POST", "/api/reports/", r, {"Origin": origin},
           {k: (v[:120] if isinstance(v, str) else v) for k, v in payload.items()})
    return r


def main():
    anon = session()
    adm = admin()

    payloads = [
        ("xss-title", {"resourceId": "gimp", "kind": "链接失效", "website": "",
                       "title": "<img src=x onerror=alert('f1')>",
                       "body": "普通正文"}),
        ("xss-body", {"resourceId": "gimp", "kind": "其他建议", "website": "",
                      "title": "反馈",
                      "body": "<script>alert('f2')</script> 以及 \" ><svg onload=alert(2)>"}),
        ("honeypot", {"resourceId": "", "kind": "其他建议", "website": "http://spam.example",
                      "title": "蜜罐测试", "body": "蜜罐内容"}),
        ("bad-kind", {"resourceId": "", "kind": "<script>alert(3)</script>", "website": "",
                      "title": "非法类型", "body": "非法类型正文"}),
        ("bad-resource", {"resourceId": "../../etc/passwd", "kind": "链接失效", "website": "",
                         "title": "非法资源", "body": "非法资源正文"}),
        ("long-fields", {"resourceId": "gimp", "kind": "其他建议", "website": "",
                        "title": "T" * 200, "body": "B" * 4200}),
    ]
    outs = []
    for tag, p in payloads:
        r = submit(anon, p, tag)
        outs.append({"tag": tag, "status": r.status_code, "retry": r.headers.get("retry-after"),
                     "resp": r.text[:200]})
    note("feedback_submissions", outs)

    # 后台反馈页呈现
    r = adm.get(BASE + "/admin/reports/", timeout=20)
    html = r.text
    record("admin-reports-render", "GET", "/admin/reports/", r)
    note("reports_status", r.status_code)
    note("reports_tokens", {
        "onerror": html.count("onerror"),
        "script_tags": len(re.findall(r"<script", html)),
        "svg": html.count("<svg"),
        "escaped_img": html.count("&lt;img"),
        "escaped_script": html.count("&lt;script"),
    })
    ctx = []
    for m in re.finditer(r"onerror|&lt;script", html):
        ctx.append(html[max(0, m.start() - 150):m.start() + 100])
        if len(ctx) >= 3:
            break
    note("reports_context", ctx)

    # 回执/编号可枚举性：观察响应体是否回泄漏内部 ID
    note("reports_body_sample", outs[0]["resp"])

    # 限流窗口与跨来源：继续提交直到 429
    seq = []
    for i in range(12):
        p = {"resourceId": "", "kind": "其他建议", "website": "",
             "title": f"rl-{i}", "body": "rate limit probe"}
        r = submit(anon, p, f"ratelimit-{i}")
        seq.append({"i": i, "status": r.status_code,
                    "retry": r.headers.get("retry-after"),
                    "remaining_hint": r.headers.get("x-ratelimit-remaining")})
        if r.status_code == 429:
            break
    note("ratelimit_sequence", seq)

    # 独立会话（不同 cookie）在同一来源再试
    fresh = session()
    r = submit(fresh, {"resourceId": "", "kind": "其他建议", "website": "",
                       "title": "fresh-session", "body": "独立会话"}, "ratelimit-fresh-session")
    note("ratelimit_fresh_session", {"status": r.status_code, "retry": r.headers.get("retry-after")})

    # 文档推荐代理会剥离 XFF；此处经 8080（透传 XFF）观察伪造转发头能否获得新额度
    for xff in ["203.0.113.9", "198.51.100.7"]:
        s2 = session()
        b = BASE.replace(":8443", ":8080")
        r = s2.post(b + "/api/reports/", data={"resourceId": "", "kind": "其他建议",
                                               "website": "", "title": "xff-" + xff,
                                               "body": "xff probe"},
                    headers={"Origin": BASE, "X-Forwarded-For": xff},
                    allow_redirects=False, timeout=20)
        record("feedback-xff-" + xff.replace(".", "-"), "POST", "/api/reports/", r,
               {"Origin": BASE, "X-Forwarded-For": xff}, {"title": "xff-" + xff})
        note("ratelimit_xff_" + xff, {"status": r.status_code,
                                      "retry": r.headers.get("retry-after")})

    with open("/tmp/sj-attacker/evidence/04-feedback-summary.json", "w") as f:
        json.dump(RES, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
