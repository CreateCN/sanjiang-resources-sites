#!/usr/bin/env python3
"""05 内容写入面：资源 JSON 字段注入、Markdown 链接绕过、预览/公开页渲染、id 路径与并发字段。"""
import json
import re
import sys
import html as htmlmod

sys.path.insert(0, "/media/sunhao/F/Project/sanjiang-resources-site/reports/security/2026-10-21-attacker/scripts")
from probe_client import session, req, csrf_from, BASE, record

ADMIN = ("atk-admin", "Atk2026-Adm1n!x")
EDITOR = ("atk-editor", "Atk2026-Edit0r!x")
RES = {}
DANGER = re.compile(r"onerror=|onload=|onmouseover=|<script|javascript:|<svg|<iframe|<img ")


def note(k, v):
    RES[k] = v
    print(f"[{k}] {json.dumps(v, ensure_ascii=False)[:600]}")


def login(s, cred):
    r = s.post(BASE + "/api/login/", data={"username": cred[0], "password": cred[1]},
               headers={"Origin": BASE}, allow_redirects=False, timeout=20)
    return r


def page(s, path):
    r = s.get(BASE + path, timeout=25, allow_redirects=False)
    return r


def csrf(s, path="/admin/"):
    r = s.get(BASE + path, timeout=20)
    return csrf_from(r.text)


BASE_RES = {
    "id": "probe-xss",
    "title": "探针资源",
    "summary": "用于黑盒测试的资源条目。",
    "category": "design", "kind": "开源工具", "cost": "免费",
    "platforms": ["Windows"], "tags": ["测试"],
    "url": "https://example.com/", "sourceUrl": "https://example.com/",
    "license": "测试许可", "eligibility": "所有人", "caveat": "测试说明",
    "steps": ["第一步", "第二步", "第三步"],
    "status": "verified", "checkedAt": "2026-10-21",
    "image": "/images/gimp.png", "imageAlt": "测试图",
    "access": "open", "imageRights": "confirmed", "imageCredit": "测试",
}

MD_PAYLOADS = [
    "[a](javascript:alert('md1'))",
    "[b](JaVaScRiPt:alert('md2'))",
    "[c](java&#115;cript:alert('md3'))",
    "[d](data:text/html,<script>alert('md4')</script>)",
    "[e](https://ok.example/ \"title\\\" onmouseover=\\\"alert('md5')\")",
    "[f][ref]\n\n[ref]: javascript:alert('md6')",
    "![g](javascript:alert('md7'))",
    "[h](<javascript:alert('md8')>)",
    "[i](\\javascript:alert('md9'))",
    "```\n[j](javascript:alert('md10'))\n```",
    "[k](vbscript:alert('md11'))",
    "[l](https://ok.example/%0Ajavascript:alert('md12'))",
]


def save_resource(s, res, version=None, extra=None, name="save-resource"):
    c = csrf(s, "/admin/resources/new/")
    data = {"csrf": c, "action": "save-resource", "resource": json.dumps(res, ensure_ascii=False)}
    if version is not None:
        data["version"] = str(version)
    if extra:
        data.update(extra)
    r = s.post(BASE + "/api/manage/", data=data, headers={"Origin": BASE},
               allow_redirects=False, timeout=30)
    record(name, "POST", "/api/manage/", r, {"Origin": BASE},
           {"action": "save-resource", "resource": "<json>", "version": version, **(extra or {})})
    return r


def inspect_html(name, html_text, label=""):
    hits = DANGER.findall(html_text)
    info = {"label": label, "danger_tokens": sorted(set(hits)),
            "count": len(hits),
            "escaped_script_count": html_text.count("&lt;script"),
            "jsonld": len(re.findall(r'application/ld\+json', html_text))}
    return info


def main():
    ed = session()
    ad = session()
    note("editor_login", login(ed, EDITOR).status_code)
    note("admin_login", login(ad, ADMIN).status_code)

    # 1. 编辑者创建带 HTML/Markdown 载荷的草稿
    res = dict(BASE_RES)
    res.update({
        "id": "probe-xss",
        "title": "<img src=x onerror=alert('title')>标题",
        "summary": "摘要 <svg/onload=alert('summary')> 文本",
        "details": "\n\n".join(MD_PAYLOADS),
        "license": "<script>alert('license')</script>",
        "eligibility": "<iframe src=javascript:alert('elig')></iframe>",
        "caveat": "\"><img src=x onerror=alert('caveat')>",
        "imageAlt": "\"><script>alert('alt')</script>",
        "imageCredit": "<b onmouseover=alert('credit')>x</b>",
        "tags": ["<img src=x onerror=alert('tag')>", "普通标签"],
        "platforms": ["<svg onload=alert('plat')>"],
        "url": "https://example.com/?a=%22%3E%3Cimg%20src=x%20onerror=alert('url')%3E",
        "sourceUrl": "https://example.com/",
    })
    r = save_resource(ed, res, name="save-resource-editor-xss")
    note("editor_save_status", (r.status_code, r.headers.get("location"),
                                r.text[:200] if r.status_code >= 400 else ""))

    # 2. 编辑者是否可以发布（预期 403）
    c = csrf(ed)
    r = ed.post(BASE + "/api/manage/", data={"csrf": c, "action": "publish", "id": "probe-xss",
                                             "version": "1"},
                headers={"Origin": BASE}, allow_redirects=False, timeout=20)
    record("editor-publish-probe", "POST", "/api/manage/", r, {"Origin": BASE},
           {"action": "publish", "id": "probe-xss", "version": 1})
    note("editor_publish", r.status_code)

    # 3. 管理员的预览页（编辑者→管理员存储型 XSS 的关键落点）
    rp = page(ad, "/admin/preview/resources/probe-xss/")
    record("admin-preview-xss", "GET", "/admin/preview/resources/probe-xss/", rp)
    note("preview_status", rp.status_code)
    note("preview_inspect", inspect_html("preview", rp.text))

    # 4. 管理员发布后前台渲染
    ca = csrf(ad, "/admin/resources/probe-xss/")
    # 先取当前版本
    rv = ad.get(BASE + "/admin/resources/probe-xss/", timeout=20)
    m = re.search(r'name="version" value="(\d+)"', rv.text)
    ver = m.group(1) if m else "1"
    note("probe_version", ver)
    r = ad.post(BASE + "/api/manage/", data={"csrf": ca, "action": "publish", "id": "probe-xss",
                                             "version": ver},
                headers={"Origin": BASE}, allow_redirects=False, timeout=20)
    record("admin-publish-probe", "POST", "/api/manage/", r, {"Origin": BASE},
           {"action": "publish", "id": "probe-xss", "version": ver})
    note("admin_publish", (r.status_code, r.headers.get("location")))

    pub = page(session(), "/resources/probe-xss/")
    record("public-probe-xss", "GET", "/resources/probe-xss/", pub)
    note("public_status", pub.status_code)
    note("public_inspect", inspect_html("public", pub.text))

    # 5. 前台的 Markdown 链接：抓取 details 渲染片段
    frag = []
    for m in re.finditer(r'href="([^"]*)"', pub.text):
        v = m.group(1)
        if any(k in v.lower() for k in ("javascript", "data:", "vbscript")):
            frag.append(v)
    note("public_suspicious_hrefs", frag)

    with open("/tmp/sj-attacker/evidence/05-content-summary.json", "w") as f:
        json.dump(RES, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
