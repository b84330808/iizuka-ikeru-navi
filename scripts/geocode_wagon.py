# -*- coding: utf-8 -*-
"""
エリアワゴン停留所の座標を解決する。
 1) stopsOverride(手動修正、最優先)
 2) 既存データ(現行GTFS stops + BODIK施設)との完全一致
 3) Nominatim(OpenStreetMap)ジオコーディング
 4) 時刻表の隣接停留所からの内挿(ワゴンは時刻表順=地理的に隣接)

出力: data/wagon/<feed>.geocoded.json  ({stop: {"lat","lon","src"}})
"""
import csv
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UA = "iizuka-norimono-navi-poc/1.0 (contest project)"


def load_csv(path, enc="cp932"):
    with open(path, encoding=enc) as f:
        return list(csv.DictReader(f))


def local_pts():
    pts = {}
    for feed in ("miyawaka", "chikuho", "old4routes"):
        p = ROOT / "data" / "gtfs" / feed / "stops.txt"
        if p.exists():
            with open(p, encoding="utf-8-sig") as f:
                for r in csv.DictReader(f):
                    pts.setdefault(r["stop_name"].strip(), (float(r["stop_lat"]), float(r["stop_lon"])))
    for fn in ("hospitals.csv", "facilities.csv"):
        for r in load_csv(ROOT / "data" / fn):
            name = (r.get("名称") or "").strip()
            if name and r.get("緯度") and r.get("経度"):
                pts.setdefault(name, (float(r["緯度"]), float(r["経度"])))
    return pts


def nominatim(name):
    q = urllib.parse.quote(f"飯塚市 {name}")
    url = f"https://nominatim.openstreetmap.org/search?q={q}&format=json&limit=1&countrycodes=jp"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        d = json.load(urllib.request.urlopen(req, timeout=15))
    except Exception:
        return None
    if not d:
        return None
    lat, lon = float(d[0]["lat"]), float(d[0]["lon"])
    # 飯塚市の妥当な範囲外は捨てる
    if 33.55 <= lat <= 33.72 and 130.60 <= lon <= 130.75:
        return (lat, lon)
    return None


def main():
    feed = sys.argv[1] if len(sys.argv) > 1 else "honami"
    data = json.load(open(ROOT / "data" / "wagon" / f"{feed}.json", encoding="utf-8"))
    override = data.get("stopsOverride", {})

    order = []
    seen = set()
    for t in data["trips"]:
        for stop, _ in t["stopTimes"]:
            if stop not in seen:
                seen.add(stop)
                order.append(stop)

    loc = local_pts()
    res = {}  # name -> (lat, lon, src)

    # 1) override, 2) local exact
    for name in order:
        if name in override and override[name]:
            res[name] = (*override[name], "override")
        elif name in loc:
            res[name] = (*loc[name], "local")

    # 3) Nominatim for the rest
    for name in order:
        if name in res:
            continue
        pt = nominatim(name)
        if pt:
            res[name] = (*pt, "osm")
            print(f"  osm   {name}")
        time.sleep(1.1)

    # 4) interpolate remaining from timetable neighbours
    for _ in range(3):  # 数回まわして連続欠損も収束させる
        changed = False
        for t in data["trips"]:
            st = t["stopTimes"]
            for i, (stop, _) in enumerate(st):
                if stop in res:
                    continue
                neigh = []
                for j in (i - 1, i + 1):
                    if 0 <= j < len(st) and st[j][0] in res:
                        neigh.append(res[st[j][0]])
                if neigh:
                    lat = sum(p[0] for p in neigh) / len(neigh)
                    lon = sum(p[1] for p in neigh) / len(neigh)
                    res[stop] = (lat, lon, "interp")
                    changed = True
        if not changed:
            break

    resolved = {k: {"lat": round(v[0], 6), "lon": round(v[1], 6), "src": v[2]} for k, v in res.items()}
    missing = [n for n in order if n not in res]

    from collections import Counter
    by_src = Counter(v["src"] for v in resolved.values())
    print(f"\n解決 {len(resolved)}/{len(order)}  内訳={dict(by_src)}  不足={len(missing)}")
    for name in order:
        if name in resolved:
            r = resolved[name]
            print(f"  {r['src']:7s} {name:24s} {r['lat']:.5f},{r['lon']:.5f}")
    if missing:
        print("不足:", missing)

    out = ROOT / "data" / "wagon" / f"{feed}.geocoded.json"
    json.dump(resolved, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"\n-> {out}")


if __name__ == "__main__":
    main()
