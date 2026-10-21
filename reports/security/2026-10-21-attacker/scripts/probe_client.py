#!/usr/bin/env python3
"""黑盒探测客户端：只发 HTTP 请求、保存响应证据，不读取项目源码。"""
import json
import os
import re
import sys
import time
import uuid
from datetime import datetime

import requests
import urllib3
urllib3.disable_warnings()

BASE = os.environ.get("SJ_BASE", "https://localhost:8443")
EV = os.environ.get("SJ_EVIDENCE", "/tmp/sj-attacker/evidence")
os.makedirs(EV, exist_ok=True)
COUNTER = [0]
DEFAULT_UA = "sj-blackbox-probe/1.0"


def next_id():
    COUNTER[0] += 1
    try:
        with open(os.path.join(EV, ".seq")) as f:
            n = int(f.read().strip())
    except Exception:
        n = 0
    n = max(n, COUNTER[0])
    with open(os.path.join(EV, ".seq"), "w") as f:
        f.write(str(n))
    return n


def session():
    s = requests.Session()
    s.verify = False
    s.headers["User-Agent"] = DEFAULT_UA
    return s


def csrf_from(html):
    for pat in (r'name="csrf(?:Token)?"[^>]*value="([^"]+)"',
                r'value="([^"]+)"[^>]*name="csrf(?:Token)?"'):
        m = re.search(pat, html)
        if m:
            return m.group(1)
    return None


def brief(body, limit=1200):
    return body[:limit]


def record(name, method, path, resp, req_headers=None, req_body=None, extra=None):
    n = next_id()
    rec = {
        "seq": n,
        "name": name,
        "time": datetime.now().astimezone().isoformat(timespec="seconds"),
        "request": {"method": method, "url": BASE + path,
                    "headers": dict(req_headers or {}), "body": req_body},
        "response": {"status": resp.status_code, "headers": dict(resp.headers),
                     "length": len(resp.content)},
        "notes": extra or {},
    }
    rec["response"]["body_excerpt"] = brief(resp.text)
    stem = f"{n:03d}-{re.sub(r'[^a-zA-Z0-9_.-]', '-', name)}"
    with open(os.path.join(EV, stem + ".json"), "w") as f:
        json.dump(rec, f, ensure_ascii=False, indent=2)
    if "text/html" in resp.headers.get("content-type", ""):
        with open(os.path.join(EV, stem + ".html"), "w") as f:
            f.write(resp.text)
    return rec, stem


def req(name, sess, method, path, *, data=None, json_body=None, headers=None,
        origin=None, allow_redirects=False, extra=None):
    h = {}
    if origin is not None:
        h["Origin"] = origin
    h.update(headers or {})
    r = sess.request(method, BASE + path, data=data, json=json_body, headers=h,
                     allow_redirects=allow_redirects, timeout=30)
    sent = {k: v for k, v in h.items()}
    if isinstance(data, dict):
        rec_body = {k: ("<...>" if k in ("password", "csrf", "csrfToken") else v)
                    for k, v in data.items()}
    else:
        rec_body = data
    if json_body is not None:
        rec_body = json_body
    return record(name, method, path, r, sent, rec_body, extra)


def login(sess, user, pw, origin=BASE):
    r = sess.post(BASE + "/api/login/", data={"username": user, "password": pw},
                  headers={"Origin": origin}, allow_redirects=False, timeout=30)
    return r


def main():
    print("probe client ready; BASE=", BASE)


if __name__ == "__main__":
    main()
