#!/usr/bin/env python3
"""15 链接检查观测：记录每条 URL 的检查结果文本，用于 SSRF/链接检查结论取证。"""
import json
import re
import sys

sys.path.insert(0, "/media/sunhao/F/Project/sanjiang-resources-site/reports/security/2026-10-21-attacker/scripts")
from probe_client import session, csrf_from, BASE, record

RES = {}
URLS = [
    ("public-example", "https://example.com/"),
    ("public-ip", "https://1.1.1.1/"),
    ("loopback", "https://127.0.0.1:4321/api/health/"),
    ("internal-name", "https://sanjiang-atk-nginx/api/health/"),
]


def main():
    s = session()
    r = s.post(BASE + "/api/login/", data={"username": "fresh-1", "password": "Fresh12026!pass"},
               headers={"Origin": BASE}, allow_redirects=False, timeout=20)
    print("login", r.status_code)
    if r.status_code != 303:
        return
    out = []
    for label, url in URLS:
        rid = "lc-" + label
        c = csrf_from(s.get(BASE + "/admin/resources/new/", timeout=20).text)
        res = {"id": rid, "title": f"链接检查 {label}", "summary": "链接检查结果观测。",
               "category": "design", "kind": "开源工具", "cost": "免费",
               "platforms": ["Windows"], "tags": ["x"], "url": url,
               "sourceUrl": "https://example.com/", "license": "l", "eligibility": "e",
               "caveat": "c", "steps": ["1", "2", "3"], "status": "verified",
               "checkedAt": "2026-10-21", "image": "/images/gimp.png", "imageAlt": "a",
               "access": "open", "imageRights": "confirmed", "imageCredit": "c"}
        s.post(BASE + "/api/manage/",
               data={"csrf": c, "action": "save-resource", "resource": json.dumps(res, ensure_ascii=False)},
               headers={"Origin": BASE}, allow_redirects=False, timeout=30)
        c = csrf_from(s.get(BASE + f"/admin/resources/{rid}/", timeout=20).text)
        r2 = s.post(BASE + "/api/manage/", data={"csrf": c, "action": "check-link", "id": rid},
                    headers={"Origin": BASE}, allow_redirects=False, timeout=60)
        page = s.get(BASE + f"/admin/resources/{rid}/", timeout=30)
        page.encoding = "utf-8"
        txt = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", page.text))
        m = re.search(r"上次检查：[^。]{0,140}", txt)
        out.append({"label": label, "url": url, "check_status": r2.status_code,
                    "redirect": r2.headers.get("location"),
                    "message": m.group(0) if m else None})
        record("linkcheck-" + label, "POST", "/api/manage/", r2, {"Origin": BASE},
               {"action": "check-link", "id": rid, "url": url},
               {"message": m.group(0) if m else None})

    # 容器内 DNS 观测，解释为什么公网目标也被拒
    import subprocess
    dns = subprocess.run(["docker", "exec", "sanjiang-atk-app", "sh", "-c",
                          "getent hosts example.com; getent hosts 1.1.1.1; getent hosts 127.0.0.1.nip.io"],
                         capture_output=True, text=True).stdout
    RES["linkcheck"] = out
    RES["container_dns"] = dns
    print(json.dumps({"linkcheck": out, "dns": dns}, ensure_ascii=False, indent=2)[:1200])
    with open("/tmp/sj-attacker/evidence/15-linkcheck.json", "w") as f:
        json.dump(RES, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
