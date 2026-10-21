#!/usr/bin/env python3
"""01 匿名侦察：站点地图、后台/接口面、响应头基线、错误处理。"""
import json
import sys

sys.path.insert(0, "/media/sunhao/F/Project/sanjiang-resources-site/reports/security/2026-10-21-attacker/scripts")
from probe_client import session, req, BASE

paths = [
    "/", "/about/", "/guides/", "/feedback/", "/resources/", "/scenarios/",
    "/sitemap.xml", "/robots.txt", "/api/health/", "/api/reports/", "/api/metrics/",
    "/api/login/", "/api/logout/", "/admin/", "/admin/login/", "/admin/resources/",
    "/admin/guides/", "/admin/categories/", "/admin/people/", "/admin/settings/",
    "/admin/import/", "/admin/export/", "/admin/trash/", "/admin/audit/",
    "/admin/metrics/", "/admin/reports/", "/admin/reviews/", "/admin/notices/",
    "/admin/preview/", "/admin/api/", "/api/admin/", "/api/admin/export/",
    "/.env", "/data/site.sqlite", "/package.json", "/src/server/entry.mjs",
    "/dist/server/entry.mjs", "/scripts/create-admin.mjs",
]

s = session()
out = []
for p in paths:
    rec, stem = req("anon-" + p.strip("/").replace("/", "-") or "anon-root", s, "GET", p)
    out.append({"path": p, "status": rec["response"]["status"],
                "len": rec["response"]["length"],
                "ctype": rec["response"]["headers"].get("content-type"),
                "location": rec["response"]["headers"].get("location"),
                "evidence": stem})
    print(f'{rec["response"]["status"]:>3} {rec["response"]["length"]:>7} {p} -> {rec["response"]["headers"].get("location")}')

with open("/media/sunhao/F/Project/sanjiang-resources-site/reports/security/2026-10-21-attacker/evidence/anon-surface.json", "w") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
