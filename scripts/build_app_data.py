# -*- coding: utf-8 -*-
"""
GTFS 2路線 + BODIK設施CSV + 分析結果 → app/data.js (window.APP_DATA)

構造:
  stops:  [{id, name, lat, lon, zone, feed}]
  trips:  [{feed, service, headsign, st: [[stopIdx, arrMin, depMin, pickup, dropoff], ...]}]
  services: {feed: {service_id: {days:[mon..sun], start, end, add:[dates], remove:[dates]}}}
  fares:  {miyawaka: {"zoneA|zoneB": price}, chikuho_flat: 200}
  facilities: [{name, kana, cat, lat, lon, tel, note}]
  headline: 分析ヘッドライン
"""
import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GTFS = ROOT / "data" / "gtfs"


def read_csv(path, enc="utf-8-sig"):
    with open(path, encoding=enc) as f:
        return list(csv.DictReader(f))


def hms_to_min(s):
    h, m, *_ = s.strip().split(":")
    return int(h) * 60 + int(m)


def load_feed(name, feed_dir):
    stops = {}
    for r in read_csv(feed_dir / "stops.txt"):
        stops[r["stop_id"]] = {
            "id": f"{name}:{r['stop_id']}",
            "name": r["stop_name"],
            "lat": float(r["stop_lat"]),
            "lon": float(r["stop_lon"]),
            "zone": (r.get("zone_id") or "").strip(),
            "feed": name,
        }
    trips_meta = {r["trip_id"]: r for r in read_csv(feed_dir / "trips.txt")}
    st_by_trip = {}
    for r in read_csv(feed_dir / "stop_times.txt"):
        st_by_trip.setdefault(r["trip_id"], []).append(r)
    trips = []
    for tid, sts in st_by_trip.items():
        sts.sort(key=lambda r: int(r["stop_sequence"]))
        meta = trips_meta[tid]
        trips.append({
            "feed": name,
            "service": meta["service_id"],
            "headsign": meta.get("trip_headsign") or "",
            "st": [[f"{name}:{r['stop_id']}",
                    hms_to_min(r["arrival_time"]),
                    hms_to_min(r["departure_time"]),
                    int(r.get("pickup_type") or 0),
                    int(r.get("drop_off_type") or 0)] for r in sts],
        })
    services = {}
    for r in read_csv(feed_dir / "calendar.txt"):
        services[r["service_id"]] = {
            "days": [int(r[d]) for d in ("monday", "tuesday", "wednesday",
                                          "thursday", "friday", "saturday", "sunday")],
            "start": r["start_date"], "end": r["end_date"], "add": [], "remove": [],
        }
    cd = feed_dir / "calendar_dates.txt"
    if cd.exists():
        for r in read_csv(cd):
            svc = services.setdefault(r["service_id"], {
                "days": [0] * 7, "start": "19000101", "end": "20991231",
                "add": [], "remove": []})
            (svc["add"] if r["exception_type"] == "1" else svc["remove"]).append(r["date"])
    return stops, trips, services


def load_fare_rules_miyawaka():
    """miyawaka: origin_id/destination_id はゾーンID。ゾーンペア→運賃。"""
    prices = {}
    for r in read_csv(GTFS / "miyawaka" / "fare_rules.txt"):
        prices[f"{r['origin_id']}|{r['destination_id']}"] = int(r["fare_id"])
    return prices


KANA_RE = re.compile(r"[ぁ-んァ-ヶー]")


def load_facilities():
    fac = []
    # 医療機関 (令和7年3月 標準データセット)
    for r in read_csv(ROOT / "data" / "hospitals.csv", enc="cp932"):
        if not r.get("緯度") or not r.get("経度"):
            continue
        kind = r.get("医療機関の種類") or ""
        dept = r.get("診療科目") or ""
        is_dental = "歯" in dept and "内科" not in dept and "外科" not in dept.replace("歯科口腔外科", "")
        cat = "dental" if is_dental else "hospital"
        fac.append({
            "name": r["名称"], "kana": r.get("名称_カナ") or "",
            "cat": cat, "lat": float(r["緯度"]), "lon": float(r["経度"]),
            "tel": r.get("電話番号") or "", "note": dept[:60],
        })
    # 公共施設
    KEEP = [("市役所", "city"), ("支所", "city"), ("出張所", "city"),
            ("交流センター", "community"), ("公民館", "community"),
            ("図書館", "community"), ("体育館", "community"),
            ("福祉", "community"), ("市民", "community")]
    for r in read_csv(ROOT / "data" / "facilities.csv", enc="cp932"):
        if not r.get("緯度") or not r.get("経度"):
            continue
        name = r["名称"]
        cat = next((c for k, c in KEEP if k in name), None)
        if not cat:
            continue
        fac.append({
            "name": name, "kana": r.get("名称_カナ") or "",
            "cat": cat, "lat": float(r["緯度"]), "lon": float(r["経度"]),
            "tel": "", "note": r.get("所在地_連結表記") or "",
        })
    return fac


# 乗合タクシー/エリアワゴン 10地区(市頁より; 詳細時刻はMVP対象外)
WAGON = {
    "url": "https://www.city.iizuka.lg.jp/shokotaisaku/machi/kotsu/bus/taxi.html",
    "note": "電話予約制(2026年7月からネット予約の実証実験も開始)。",
    "fares": "エリアワゴン100円 / 乗合タクシー300円(障がい者200円)",
    "districts": ["頴田", "鯰田", "幸袋", "鎮西", "二瀬", "穂波",
                  "菰田", "飯塚東", "庄内", "筑穂"],
}


def main():
    all_stops, all_trips = {}, []
    services = {}
    for name in ("miyawaka", "chikuho"):
        stops, trips, svcs = load_feed(name, GTFS / name)
        all_stops.update({s["id"]: s for s in stops.values()})
        all_trips += trips
        services[name] = svcs

    stop_ids = list(all_stops.keys())
    idx = {sid: i for i, sid in enumerate(stop_ids)}
    for t in all_trips:
        t["st"] = [[idx[sid], a, d, pu, do] for sid, a, d, pu, do in t["st"]]

    with open(ROOT / "data" / "processed" / "analysis.json", encoding="utf-8") as f:
        headline = json.load(f)["headline"]

    data = {
        "stops": [all_stops[sid] for sid in stop_ids],
        "trips": all_trips,
        "services": services,
        "fares": {"miyawaka": load_fare_rules_miyawaka(), "chikuho_flat": 200},
        "routeNames": {"miyawaka": "宮若・飯塚線", "chikuho": "筑穂・高田線"},
        "facilities": load_facilities(),
        "wagon": WAGON,
        "headline": headline,
    }
    out = ROOT / "app" / "data.js"
    out.parent.mkdir(exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write("window.APP_DATA=")
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";")
    print(f"stops={len(stop_ids)} trips={len(all_trips)} "
          f"facilities={len(data['facilities'])} -> {out} ({out.stat().st_size//1024}KB)")


if __name__ == "__main__":
    main()
