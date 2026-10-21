#!/usr/bin/env python3
"""12 匿名反馈配额：精确计数、蜜罐是否计数、跨来源是否共享、恢复时间。"""
import json
import subprocess
import sys
import time

sys.path.insert(0, "/media/sunhao/F/Project/sanjiang-resources-site/reports/security/2026-10-21-attacker/scripts")
from probe_client import session, record

BASE = sys.argv[1] if len(sys.argv) > 1 else "https://localhost:8473"
CONTAINER = sys.argv[2] if len(sys.argv) > 2 else "sj-probe"
RES = {}


def note(k, v):
    RES[k] = v
    print(f"[{k}] {json.dumps(v, ensure_ascii=False)[:600]}")


def submit(title, body, honeypot=""):
    s = session()
    r = s.post(BASE + "/api/reports/", data={"resourceId": "", "kind": "其他建议",
                                             "website": honeypot, "title": title, "body": body},
               headers={"Origin": BASE}, allow_redirects=False, timeout=20)
    return r


def main():
    seq = []
    t0 = time.time()
    for i in range(12):
        r = submit(f"quota-{i}", "配额探测正文，长度足够不超过上限。")
        seq.append({"i": i + 1, "status": r.status_code, "retry": r.headers.get("retry-after"),
                    "elapsed": round(time.time() - t0, 1)})
        if r.status_code == 429:
            break
    note("quota_sequence", seq)
    total = len(seq)

    # 独立来源是否共享配额
    out = subprocess.run(["docker", "exec", CONTAINER, "curl", "-sk", "-m", "10", "-o", "/dev/null",
                          "-w", "%{http_code}",
                          "-X", "POST", BASE.replace("://localhost", "://" + BASE.split("//")[1].split(":")[0].replace("localhost", CONTAINER)) + "/api/reports/"],
                         capture_output=True, text=True)
    note("independent_source_raw", out.stdout.strip()[:20])

    with open("/tmp/sj-attacker/evidence/12-feedback-quota.json", "w") as f:
        json.dump(RES, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
