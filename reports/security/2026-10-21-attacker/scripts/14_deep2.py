#!/usr/bin/env python3
"""14 CSRF 轮换、设置/指南注入、后台反射点、会话并发与撤销、编辑者边界。"""
import json
import re
import sys

sys.path.insert(0, "/media/sunhao/F/Project/sanjiang-resources-site/reports/security/2026-10-21-attacker/scripts")
from probe_client import session, record, csrf_from, BASE

ADMIN = ("atk-admin", "Atk2026-Adm1n!x")
EDITOR = ("atk-editor", "Atk2026-Edit0r!x")
RES = {}


def note(k, v):
    RES[k] = v
    print(f"[{k}] {json.dumps(v, ensure_ascii=False)[:700]}")


def msg(t):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", t)).strip()[:180]


def main():
    s = session()
    r = s.post(BASE + "/api/login/", data={"username": ADMIN[0], "password": ADMIN[1]},
               headers={"Origin": BASE}, allow_redirects=False, timeout=20)
    note("admin_login", r.status_code)
    if r.status_code != 303:
        note("blocked", msg(r.text))
        return

    def fresh_csrf(path="/admin/settings/"):
        return csrf_from(s.get(BASE + path, timeout=20).text)

    def post(name, path_for_csrf, **fields):
        c = fresh_csrf(path_for_csrf)
        r = s.post(BASE + "/api/manage/", data={"csrf": c, **fields},
                   headers={"Origin": BASE}, allow_redirects=False, timeout=40)
        record(name, "POST", "/api/manage/", r, {"Origin": BASE},
               {k: (v[:60] if isinstance(v, str) else v) for k, v in fields.items()})
        return r

    # 1. CSRF 是否单次有效（轮换验证）
    c1 = fresh_csrf()
    r1 = s.post(BASE + "/api/manage/", data={"csrf": c1, "action": "save-category",
                                             "id": "csrf-a", "name": "CSRF A"},
                headers={"Origin": BASE}, allow_redirects=False, timeout=20)
    r2 = s.post(BASE + "/api/manage/", data={"csrf": c1, "action": "save-category",
                                             "id": "csrf-b", "name": "CSRF B"},
                headers={"Origin": BASE}, allow_redirects=False, timeout=20)
    note("csrf_reuse", {"first": (r1.status_code, msg(r1.text)), "second": (r2.status_code, msg(r2.text))})

    # 2. 设置注入（逐字段定位校验）
    page = s.get(BASE + "/admin/settings/", timeout=20).text
    base_fields = {}
    for m in re.finditer(r'<input[^>]*name="(scenario\.[^"]*)"[^>]*value="([^"]*)"', page):
        base_fields[m.group(1)] = m.group(2)
    src = s.get(BASE + "/admin/settings/", timeout=20).text
    # 用页面原始值构造，避免编码误差
    cases = {
        "html-task": {"scenario.design.task": "<img src=x onerror=alert('s1')>"},
        "quote-task": {"scenario.design.task": '" onmouseover="alert(2)'},
        "lt-only": {"scenario.design.task": "a < b"},
        "quote-detail": {"scenario.design.detail": '"'},
        "glyph-script": {"scenario.design.glyph": "<script>"},
        "long-task": {"scenario.design.task": "T" * 400},
    }
    out = {}
    for label, patch in cases.items():
        fields = {"action": "save-settings", "featuredResourceId": "gimp"}
        fields.update({k: v for k, v in base_fields.items()})
        fields.update(patch)
        r = post("settings-" + label, "/admin/settings/", **fields)
        out[label] = {"status": r.status_code, "msg": msg(r.text),
                      "location": r.headers.get("location")}
    note("settings_cases", out)
    home = s.get(BASE + "/", timeout=20).text
    note("home_injection_check", {
        "raw_img": "<img src=x onerror=alert('s1')>" in home,
        "raw_quote_payload": 'onmouseover="alert(2)' in home,
        "escaped": "&lt;img" in home,
    })
    # 还原
    post("settings-restore", "/admin/settings/", action="save-settings",
         featuredResourceId="gimp", **base_fields)

    # 3. 指南保存 + 预览/公开渲染
    gpage = s.get(BASE + "/admin/guides/new/", timeout=20).text
    gfields = {"slug": "probe-guide", "title": "<img src=x onerror=alert('gt')>指南",
               "summary": "<svg onload=alert('gs')>摘要",
               "body": "\n\n".join(["# 测试标题", "[x](javascript:alert('g1'))",
                                   "<script>alert('g2')</script>",
                                   "![i](data:image/svg+xml,<svg onload=alert(1)>)",
                                   "|a|b|\n|-|-|\n|<img src=x onerror=alert('g3')>|2|",
                                   "[y](https://ok.example/ \"t\\\\\" onmouseover=alert(4)\")"]),
               "resources": "gimp", "version": ""}
    r = post("save-guide", "/admin/guides/new/", action="save-guide", **gfields)
    note("save_guide", (r.status_code, r.headers.get("location"), msg(r.text)))
    prev = s.get(BASE + "/admin/preview/guides/probe-guide/", timeout=20, allow_redirects=False)
    note("guide_preview", {"status": prev.status_code,
                           "danger": sorted(set(re.findall(r"onerror=|onload=|<script", prev.text)))[:6]})
    record("guide-preview", "GET", "/admin/preview/guides/probe-guide/", prev)
    # 发布指南需要版本
    gpage2 = s.get(BASE + "/admin/guides/probe-guide/", timeout=20).text
    mv = re.search(r'name="version" value="(\d+)"', gpage2)
    note("guide_version", mv.group(1) if mv else None)
    if mv:
        r = post("publish-guide", "/admin/guides/probe-guide/", action="publish",
                 id="probe-guide", version=mv.group(1))
        note("publish_guide", (r.status_code, r.headers.get("location"), msg(r.text)))
        pub = s.get(BASE + "/guides/probe-guide/", timeout=20, allow_redirects=False)
        note("public_guide", {"status": pub.status_code,
                              "danger": sorted(set(re.findall(r"onerror=|onload=|<script", pub.text)))[:6],
                              "raw_script": "alert('g2')</script>" in pub.text})
        record("public-guide", "GET", "/guides/probe-guide/", pub)

    # 4. 后台反射点
    refl = {}
    payload = '" onmouseover="alert(9)'
    for path in ["/admin/resources/?q=", "/admin/reports/?q=", "/admin/audit/?q=",
                 "/admin/resources/gimp/?checked=", "/admin/trash/?q="]:
        import urllib.parse
        p = path + urllib.parse.quote(payload)
        r = s.get(BASE + p, timeout=20, allow_redirects=False)
        raw = payload in r.text
        refl[path] = {"status": r.status_code, "raw_reflection": raw,
                      "escaped": "&quot; onmouseover=&quot;alert(9)" in r.text}
        record("admin-reflect-" + re.sub(r"[^a-z]", "", path)[:20], "GET", p, r, extra={"raw": raw})
    note("admin_reflections", refl)

    # 5. 会话并发与撤销
    s2 = session()
    r = s2.post(BASE + "/api/login/", data={"username": ADMIN[0], "password": ADMIN[1]},
                headers={"Origin": BASE}, allow_redirects=False, timeout=20)
    note("second_login", r.status_code)
    a1 = s.get(BASE + "/admin/", timeout=20)
    a2 = s2.get(BASE + "/admin/", timeout=20)
    note("concurrent_sessions", {"first_session": a1.status_code, "second_session": a2.status_code,
                                 "first_is_dashboard": "/admin/resources/" in a1.text,
                                 "second_is_dashboard": "/admin/resources/" in a2.text})
    record("session-concurrency-first", "GET", "/admin/", a1)
    record("session-concurrency-second", "GET", "/admin/", a2)

    # 6. 编辑者边界（登录 + 关键接口）
    ed = session()
    r = ed.post(BASE + "/api/login/", data={"username": EDITOR[0], "password": EDITOR[1]},
                headers={"Origin": BASE}, allow_redirects=False, timeout=20)
    note("editor_login", r.status_code)
    if r.status_code == 303:
        ec = csrf_from(ed.get(BASE + "/admin/resources/", timeout=20).text)
        checks = {}
        for path in ["/api/export/", "/admin/audit/", "/admin/users/", "/admin/settings/",
                     "/admin/import/", "/admin/categories/", "/admin/maintenance/",
                     "/admin/trash/", "/admin/metrics/"]:
            rr = ed.get(BASE + path, allow_redirects=False, timeout=20)
            checks[path] = {"status": rr.status_code, "len": len(rr.content),
                            "location": rr.headers.get("location"),
                            "ctype": rr.headers.get("content-type")}
            record("editor-get-" + re.sub(r"[^a-zA-Z]", "", path)[:18], "GET", path, rr)
        note("editor_boundary", checks)
        # 编辑者可写：保存草稿、检查链接；不可写：发布
        rc = ed.post(BASE + "/api/manage/", data={"csrf": ec, "action": "check-link", "id": "gimp"},
                     headers={"Origin": BASE}, allow_redirects=False, timeout=60)
        note("editor_checklink", (rc.status_code, rc.headers.get("location")))
        record("editor-checklink", "POST", "/api/manage/", rc, {"Origin": BASE},
               {"action": "check-link", "id": "gimp"})
        rp = ed.post(BASE + "/api/manage/", data={"csrf": ec, "action": "publish", "id": "gimp",
                                                  "version": "1"},
                     headers={"Origin": BASE}, allow_redirects=False, timeout=20)
        note("editor_publish", rp.status_code)

    with open("/tmp/sj-attacker/evidence/14-deep2.json", "w") as f:
        json.dump(RES, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
