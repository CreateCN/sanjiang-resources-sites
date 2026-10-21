#!/usr/bin/env python3
"""02 认证与会话攻击面：会话固定、Cookie、退出重放、密码重置撤销、Origin/CSRF 绕过、限流键。"""
import json
import re
import sys
import time

sys.path.insert(0, "/media/sunhao/F/Project/sanjiang-resources-site/reports/security/2026-10-21-attacker/scripts")
from probe_client import session, req, record, csrf_from, BASE, login

ADMIN = ("atk-admin", "Atk2026-Adm1n!x")
EDITOR = ("atk-editor", "Atk2026-Edit0r!x")
RES = {}
ADM_S = session()
EDIT_S = session()


def note(k, v):
    RES[k] = v
    print(f"[{k}] {v}")


def admin_csrf(s, path="/admin/"):
    r = s.get(BASE + path, verify=False, timeout=20)
    return csrf_from(r.text)


def manage(s, csrf, **fields):
    d = {"csrf": csrf}
    d.update(fields)
    return req("manage-" + fields.get("action", "?"), s, "POST", "/api/manage/",
               data=d, origin=BASE)


def main():
    # --- 0. 管理员登录，取 CSRF
    a = login(ADM_S, *ADMIN)
    c = admin_csrf(ADM_S)
    record("login-admin", "POST", "/api/login/", a, {"Origin": BASE},
           {"username": ADMIN[0], "password": "<...>"})
    note("admin_login", a.status_code)
    note("admin_cookie", a.headers.get("set-cookie", ""))
    note("admin_csrf_prefix", c[:16] if c else None)

    # --- 1. 创建编辑者账号（文档化后台流程）
    r = manage(ADM_S, c, action="create-user", username=EDITOR[0], password=EDITOR[1], role="editor")
    note("create_editor", (r[0]["response"]["status"], r[1]))
    c2 = admin_csrf(ADM_S)

    # --- 2. 会话固定：登录前后 session 值是否变化
    pre = session()
    pre.get(BASE + "/admin/login/", verify=False)
    pre_token = pre.cookies.get("sanjiang_session")
    pre_posted_csrf = csrf_from(pre.get(BASE + "/admin/login/", verify=False).text)
    lr = login(pre, *EDITOR)
    post_token = pre.cookies.get("sanjiang_session")
    note("session_fixation", {"pre_login_token": pre_token, "post_login_token": post_token,
                              "changed": pre_token != post_token,
                              "login_status": lr.status_code})
    record("login-editor-fixation", "POST", "/api/login/", lr, {"Origin": BASE},
           {"username": EDITOR[0], "password": "<...>"},
           {"pre_token": pre_token, "post_token": post_token})

    # --- 3. 编辑者登录并检查 Cookie 属性
    el = login(EDIT_S, *EDITOR)
    note("editor_cookie", el.headers.get("set-cookie", ""))
    note("editor_login", el.status_code)

    # --- 4. Origin / CSRF 绕过矩阵（编辑者会话，写操作）
    ecsrf = admin_csrf(EDIT_S)
    variants = [
        ("no-origin", {"Origin": None}, {}),
        ("null-origin", {"Origin": "null"}, {}),
        ("suffix-origin", {"Origin": "https://localhost:8443.evil.example"}, {}),
        ("userinfo-origin", {"Origin": "https://localhost:8443@evil.example"}, {}),
        ("prefix-origin", {"Origin": "https://evil.example?https://localhost:8443"}, {}),
        ("http-origin", {"Origin": "http://localhost:8443"}, {}),
        ("port-swap-origin", {"Origin": "https://localhost:8444"}, {}),
        ("upper-origin", {"Origin": "https://LOCALHOST:8443"}, {}),
        ("trailing-dot", {"Origin": "https://localhost.:8443"}, {}),
        ("ok-origin", {"Origin": BASE}, {}),
    ]
    matrix = {}
    for name, hdr, _ in variants:
        h = {k: v for k, v in hdr.items() if v is not None}
        r = EDIT_S.post(BASE + "/api/manage/", data={"csrf": ecsrf, "action": "update-settings",
                                                   "site_name": "probe-" + name},
                        headers=h, allow_redirects=False, timeout=20)
        matrix[name] = r.status_code
        record("origin-" + name, "POST", "/api/manage/", r, h,
               {"csrf": "<...>", "action": "update-settings", "site_name": "probe-" + name})
    note("origin_matrix", matrix)

    # --- 5. CSRF token 混淆：缺失/错误/他人 token
    csrf_matrix = {}
    for name, tok in [("missing", None), ("empty", ""), ("garbage", "de" * 32),
                      ("admin-token", c2)]:
        d = {"action": "update-settings", "site_name": "x"}
        if tok is not None:
            d["csrf"] = tok
        r = EDIT_S.post(BASE + "/api/manage/", data=d, headers={"Origin": BASE},
                        allow_redirects=False, timeout=20)
        csrf_matrix[name] = r.status_code
        record("csrf-" + name, "POST", "/api/manage/", r, {"Origin": BASE},
               {**d, "csrf": "<...>"})
    note("csrf_matrix", csrf_matrix)

    # --- 6. 编辑者越权矩阵
    ecsrf = admin_csrf(EDIT_S)
    pages = ["/admin/users/", "/admin/settings/", "/admin/categories/", "/admin/import/",
             "/admin/export/", "/admin/audit/", "/admin/metrics/", "/admin/trash/",
             "/admin/maintenance/", "/admin/resources/", "/admin/reports/", "/admin/reviews/"]
    pm = {}
    for p in pages:
        r = EDIT_S.get(BASE + p, allow_redirects=False, timeout=20)
        pm[p] = (r.status_code, r.headers.get("location"))
        record("editor-page-" + p.strip("/").replace("/", "-"), "GET", p, r)
    note("editor_page_matrix", pm)

    writes = [
        ("create-user", {"action": "create-user", "username": "atk-sneak", "password": "Sneaky1234!x", "role": "admin"}),
        ("update-user-self", {"action": "update-user", "id": "2", "role": "admin", "active": "true"}),
        ("update-user-admin", {"action": "update-user", "id": "1", "role": "editor", "active": "true"}),
        ("update-settings", {"action": "update-settings", "site_name": "pwned"}),
        ("create-category", {"action": "create-category", "name": "pwn", "id": "pwn"}),
        ("publish", {"action": "publish", "kind": "resource", "slug": "gimp"}),
        ("delete", {"action": "delete", "kind": "resource", "slug": "gimp"}),
        ("import", {"action": "import", "payload": "{}"}),
        ("export", {"action": "export"}),
        ("restore", {"action": "restore", "kind": "resource", "slug": "gimp"}),
        ("purge", {"action": "purge", "kind": "resource", "slug": "gimp"}),
        ("update-resource", {"action": "update-resource", "slug": "gimp", "title": "editor-edit"}),
    ]
    wm = {}
    for name, fields in writes:
        r = manage(EDIT_S, ecsrf, **fields)
        wm[name] = (r[0]["response"]["status"], r[1])
    note("editor_write_matrix", wm)

    # --- 7. 退出与重放
    r = req("logout", EDIT_S, "POST", "/api/logout/", data={"csrf": ecsrf}, origin=BASE)
    note("logout", (r[0]["response"]["status"], r[1]))
    r = req("after-logout-dashboard", EDIT_S, "GET", "/admin/", allow_redirects=False)
    note("after_logout_read", r[0]["response"]["status"])
    r = req("after-logout-write", EDIT_S, "POST", "/api/manage/",
            data={"csrf": ecsrf, "action": "update-settings", "site_name": "y"}, origin=BASE)
    note("after_logout_write", r[0]["response"]["status"])

    with open("/tmp/sj-attacker/evidence/02-auth-summary.json", "w") as f:
        json.dump(RES, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
