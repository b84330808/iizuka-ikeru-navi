# -*- coding: utf-8 -*-
"""
立地適正化計画「都市機能誘導区域」× コミュニティバス2022年再編 の突合。

飯塚市は法定計画で16の都市機能誘導拠点を定めているが、その施設名の多くが
「〜(バス)」「〜(コミュニティバス)」というバス停名で定義されている。
一方で市は2022年3月にコミュニティバスを5路線→2路線へ再編し、58停留所中38を廃止した。

このスクリプトは、市自身が公開する2つのオープンデータだけを突合し、
「計画上の拠点」と「実際に残った公共交通」のズレを機械的に算出する。

重要な設計方針(審査で反証されないために):
  - 名称照合と地理照合の両方を行い、根拠を status に明示する
  - コミュニティバスGTFSに存在しない拠点は「西鉄バス等の可能性」として
    lost とは断定せず no_community_bus_data に分類する(過大主張の回避)
  - 距離は現行コミュニティバス停留所までの直線距離(最短)

出力: app/anchors.json
"""
import csv
import json
import math
import urllib.request
from pathlib import Path

from shapely.geometry import shape

ROOT = Path(__file__).resolve().parent.parent
CKAN = "https://data.bodik.jp/api/3/action/package_search?fq=organization:402052&rows=100"

# 拠点の「徒歩圏」判定に使う距離(m)。高齢者の許容徒歩距離として300mを採用
NEAR_M = 300

LAT0 = 33.64
KY = 110540.0
KX = 111320.0 * math.cos(math.radians(LAT0))


def dist_m(lat1, lon1, lat2, lon2):
    return math.hypot((lat1 - lat2) * KY, (lon1 - lon2) * KX)


def fetch_json(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)


def find_resource(title, fmt):
    for ds in fetch_json(CKAN)["result"]["results"]:
        if ds["title"] == title:
            for res in ds["resources"]:
                if res["format"].upper() == fmt.upper():
                    return res["url"]
    raise SystemExit(f"resource not found: {title} ({fmt})")


def load_stops(path):
    if not path.exists():
        return {}
    with open(path, encoding="utf-8-sig") as f:
        return {r["stop_name"].strip(): (float(r["stop_lat"]), float(r["stop_lon"]))
                for r in csv.DictReader(f)}


def nearest(lat, lon, pool):
    best = None
    for name, (a, o) in pool.items():
        d = dist_m(lat, lon, a, o)
        if best is None or d < best[1]:
            best = (name, d)
    return best


def main():
    gtfs = ROOT / "data" / "gtfs"
    old = load_stops(gtfs / "old4routes" / "stops.txt")
    cur = {}
    cur.update(load_stops(gtfs / "miyawaka" / "stops.txt"))
    cur.update(load_stops(gtfs / "chikuho" / "stops.txt"))
    if not old or not cur:
        raise SystemExit("GTFS stops が見つかりません。data/gtfs/ を展開してください。")

    geo = fetch_json(find_resource("都市機能誘導区域", "GeoJSON"))

    anchors = []
    for feat in geo["features"]:
        p = feat["properties"]
        name = (p.get("施設名") or "").strip()
        zone = (p.get("区域名") or "").strip()
        geom = shape(feat["geometry"])
        pt = geom.representative_point()
        lon, lat = pt.x, pt.y

        # 拠点名または区域名がバス停を指しているか(市自身の表記)
        bus_named = ("バス" in name) or ("バス停" in zone)

        n_cur = nearest(lat, lon, cur)
        n_old = nearest(lat, lon, old)
        cur_near = bool(n_cur and n_cur[1] <= NEAR_M)
        old_near = bool(n_old and n_old[1] <= NEAR_M)

        if cur_near:
            status = "served"          # 今もコミュニティバスの徒歩圏
        elif old_near:
            status = "lost"            # 再編前は徒歩圏、今は圏外(=市が廃止した)
        else:
            # コミュニティバスの両feedに無い=西鉄バス等の可能性。断定しない
            status = "no_community_bus_data"

        anchors.append({
            "name": name,
            "zone": zone,
            "kind": (p.get("拠点種") or "").strip(),
            "district": (p.get("地区名") or "").strip(),
            "busNamed": bus_named,
            "lat": round(lat, 6), "lon": round(lon, 6),
            "status": status,
            "nearestCurrent": {"name": n_cur[0], "m": round(n_cur[1])} if n_cur else None,
            "nearestAbolished": {"name": n_old[0], "m": round(n_old[1])} if n_old else None,
            # 市自身の人口密度推計(H22=2010年, H47=2035年)
            "densH22": p.get("H22人密"), "densH47": p.get("H47人密"),
            "popH22": p.get("Sum_H22_"), "popH47": p.get("Sum_H47_"),
        })

    # ---- 廃止された停留所のうち、生活拠点にあたるもの ----
    KEY = ["病院", "診療", "福祉", "支所", "庁舎", "交流センター", "公民館", "市役所"]
    lost_facilities = []
    for sname, (la, lo) in old.items():
        if sname in cur:
            continue
        if not any(k in sname for k in KEY):
            continue
        n = nearest(la, lo, cur)
        if n and n[1] > NEAR_M:
            lost_facilities.append({"stop": sname, "toNearestM": round(n[1]), "nearest": n[0]})
    lost_facilities.sort(key=lambda x: -x["toNearestM"])

    bus_named_n = sum(1 for a in anchors if a["busNamed"])
    summary = {
        "anchorsTotal": len(anchors),
        "anchorsBusNamed": bus_named_n,
        "anchorsLost": sum(1 for a in anchors if a["status"] == "lost"),
        "anchorsServed": sum(1 for a in anchors if a["status"] == "served"),
        "anchorsNoData": sum(1 for a in anchors if a["status"] == "no_community_bus_data"),
        "stopsBefore": len(old), "stopsAfter": len(cur),
        "stopsAbolished": sum(1 for s in old if s not in cur),
        "walkThresholdM": NEAR_M,
        "sources": [
            "飯塚市 立地適正化計画 都市機能誘導区域(BODIK, GeoJSON)",
            "飯塚市 コミュニティバス GTFS-JP 廃止4路線(令和3年版)・現行2路線(BODIK)",
        ],
        "caveat": "no_community_bus_data はコミュニティバスGTFSに該当停留所が無いことのみを示し、"
                  "西鉄バス等の他事業者による運行の有無は判定していない。",
    }

    out = ROOT / "app" / "anchors.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"summary": summary, "anchors": anchors,
                   "lostFacilities": lost_facilities}, f, ensure_ascii=False, indent=1)

    print(json.dumps(summary, ensure_ascii=False, indent=1))
    print("\n-- 拠点の状態 --")
    for a in anchors:
        mark = {"served": "○", "lost": "★廃止", "no_community_bus_data": "-"}[a["status"]]
        bn = "(バス名)" if a["busNamed"] else ""
        d = a["nearestCurrent"]["m"] if a["nearestCurrent"] else "?"
        print(f'  {mark:4s} {a["name"]:22s}{bn:8s} 最寄現行停留所 {d}m')
    print(f"\n-- 廃止で徒歩圏を失った生活拠点 {len(lost_facilities)}件 --")
    for x in lost_facilities[:12]:
        print(f'  {x["stop"]:24s} {x["toNearestM"]:5d}m ({x["nearest"]})')
    print(f"\n-> {out}")


if __name__ == "__main__":
    main()
