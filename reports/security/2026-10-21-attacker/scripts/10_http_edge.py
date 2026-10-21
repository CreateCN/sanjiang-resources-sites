#!/usr/bin/env python3
"""10 HTTP 边界与代理层：Host 处理、方法、参数污染、请求体限制、CORS、TRACE。"""
import json
import socket
import ssl
import sys

sys.path.insert(0, "/media/sunhao/F/Project/sanjiang-resources-site/reports/security/2026-10-21-attacker/scripts")
from probe_client import session, req, BASE, record

RES = {}


def note(k, v):
    RES[k] = v
    print(f"[{k}] {json.dumps(v, ensure_ascii=False)[:600]}")


def main():
    s = session()

    # 1. Host 头处理：canonical / OG / sitemap 是否跟随 Host
    out = {}
    for host in ["localhost:8443", "evil.example", "evil.example:8443", "127.0.0.1:8443",
                 "localhost:8443, evil.example"]:
        r = s.get(BASE + "/", headers={"Host": host}, timeout=20, allow_redirects=False)
        can = r.headers.get("content-location")
        import re
        m = re.search(r'<link rel="canonical" href="([^"]*)"', r.text)
        m2 = re.search(r'<meta property="og:url" content="([^"]*)"', r.text)
        out[host] = {"status": r.status_code,
                     "canonical": m.group(1) if m else None,
                     "og_url": m2.group(1) if m2 else None,
                     "location": r.headers.get("location")}
        record("host-" + host.replace(":", "_").replace(" ", "").replace(",", "_"), "GET", "/", r,
               {"Host": host})
    note("host_header", out)

    # 2. 方法矩阵
    methods = {}
    for method in ["OPTIONS", "TRACE", "PUT", "DELETE", "PATCH", "HEAD"]:
        try:
            r = s.request(method, BASE + "/api/manage/", timeout=20, allow_redirects=False,
                          headers={"Origin": BASE})
            methods[method] = {"status": r.status_code,
                               "allow": r.headers.get("allow"),
                               "body_len": len(r.content)}
            record("method-" + method, method, "/api/manage/", r, {"Origin": BASE})
        except Exception as e:
            methods[method] = {"error": str(e)}
    for method in ["OPTIONS", "TRACE"]:
        r = s.request(method, BASE + "/", timeout=20, allow_redirects=False)
        methods["root-" + method] = {"status": r.status_code, "allow": r.headers.get("allow")}
        record("method-root-" + method, method, "/", r)
    note("methods", methods)

    # 3. 参数污染：同一 action 出现两次（未认证）
    from urllib.parse import urlencode
    body = [("action", "save-settings"), ("action", "noop"), ("csrf", "x"), ("site_name", "dup")]
    raw = urlencode(body)
    r = s.post(BASE + "/api/manage/", data=raw,
               headers={"Origin": BASE, "Content-Type": "application/x-www-form-urlencoded"},
               timeout=20, allow_redirects=False)
    record("param-pollution", "POST", "/api/manage/", r, {"Origin": BASE}, {"raw": raw})
    note("param_pollution_unauth", r.status_code)

    # 4. JSON 内容类型打到表单接口
    r = s.post(BASE + "/api/manage/", json={"action": "save-settings", "csrf": "x", "site_name": "j"},
               headers={"Origin": BASE}, timeout=20, allow_redirects=False)
    record("json-on-form-endpoint", "POST", "/api/manage/", r, {"Origin": BASE, "Content-Type": "application/json"}, {"json": True})
    note("json_body_on_form_api", {"status": r.status_code, "body": r.text[:120]})

    # 5. 超大请求体（Nginx 1m 限制）
    big = "A" * (1024 * 1024 + 1024)
    r = s.post(BASE + "/api/reports/", data={"title": "big", "body": big},
               headers={"Origin": BASE}, timeout=60, allow_redirects=False)
    record("oversize-body", "POST", "/api/reports/", r, {"Origin": BASE},
           {"body": f"<{len(big)} bytes>"})
    note("oversize_body", {"status": r.status_code, "len": len(r.content)})

    # 6. CORS
    r = s.get(BASE + "/api/health/", headers={"Origin": "https://evil.example"}, timeout=20)
    note("cors_health", {"acao": r.headers.get("access-control-allow-origin"),
                         "acac": r.headers.get("access-control-allow-credentials"),
                         "status": r.status_code})
    record("cors-health", "GET", "/api/health/", r, {"Origin": "https://evil.example"})

    # 7. 请求走私探针（只观察响应，不追求破坏）
    def raw(sock_payload):
        ctx = ssl._create_unverified_context()
        with socket.create_connection(("127.0.0.1", 8443), timeout=8) as sock:
            with ctx.wrap_socket(sock, server_hostname="localhost") as ss:
                ss.sendall(sock_payload)
                ss.settimeout(6)
                data = b""
                try:
                    while len(data) < 4096:
                        chunk = ss.recv(4096)
                        if not chunk:
                            break
                        data += chunk
                except Exception:
                    pass
                return data.decode("latin1", "replace")

    smuggle = {}
    p1 = (b"POST /api/event/ HTTP/1.1\r\nHost: localhost:8443\r\nContent-Type: application/json\r\n"
          b"Content-Length: 34\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
          b'{"name":"search_miss","target":"cl"}\r\n0\r\n\r\n')
    smuggle["cl_te"] = raw(p1)[:200]
    p2 = (b"POST /api/event/ HTTP/1.1\r\nHost: localhost:8443\r\nContent-Type: application/json\r\n"
          b"Content-Length: 5\r\nContent-Length: 34\r\nConnection: close\r\n\r\n"
          b'{"name":"search_miss","target":"dupcl"}')
    smuggle["dup_cl"] = raw(p2)[:200]
    p3 = b"GET / HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n"
    smuggle["absolute"] = raw(p3)[:200]
    note("smuggling", smuggle)

    with open("/tmp/sj-attacker/evidence/10-http-summary.json", "w") as f:
        json.dump(RES, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
