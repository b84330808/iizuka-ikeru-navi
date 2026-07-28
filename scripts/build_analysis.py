# -*- coding: utf-8 -*-
"""
殺手鐧分析:2022/3 コミュニティバス廃線前後のバス停徒歩圏 × 町丁別高齢者人口

前(~2022/3): 旧4路線(頴田・飯塚線、庄内・飯塚線、筑穂・飯塚線、高田・鎮西線) + 宮若・飯塚線
後(現行):   宮若・飯塚線 + 筑穂・高田線

人口: 令和2年(2020)国勢調査 小地域集計 T001082(年齢別人口)を KEY_CODE で
      町丁界(e-Stat r2ka40205)と結合。65歳以上 = T001082019。
バス停徒歩圏 = 300m(高齢者の許容徒歩距離の目安)

出力:
  data/processed/analysis.json   町丁別の被覆率・高齢者人口・喪失分類
  data/processed/towns.geojson   地図用 GeoJSON(被覆率・分類付き)
  output/killer_map.html         folium 疊圖(互動地圖)
"""
import csv
import json
import math
from collections import defaultdict
from pathlib import Path

import folium
import shapefile
from shapely.geometry import Point, mapping, shape as shp_shape
from shapely.ops import unary_union, transform

ROOT = Path(__file__).resolve().parent.parent
WALK_M = 300  # 徒歩圏半径(m)

# ---- 局所メートル投影(飯塚周辺 lat~33.6) ----
LAT0, LON0 = 33.64, 130.69
KX = 111320 * math.cos(math.radians(LAT0))  # m / deg lon
KY = 110540                                  # m / deg lat


def to_m(lon, lat):
    return (lon - LON0) * KX, (lat - LAT0) * KY


def from_m(x, y):
    return x / KX + LON0, y / KY + LAT0


def project(geom):
    return transform(lambda x, y, z=None: to_m(x, y), geom)


def unproject(geom):
    return transform(lambda x, y, z=None: from_m(x, y), geom)


def load_stops(feed_dir):
    with open(feed_dir / "stops.txt", encoding="utf-8-sig") as f:
        return [{"id": r["stop_id"], "name": r["stop_name"],
                 "lat": float(r["stop_lat"]), "lon": float(r["stop_lon"])}
                for r in csv.DictReader(f)]


def coverage_union(stops):
    return unary_union([Point(*to_m(s["lon"], s["lat"])).buffer(WALK_M) for s in stops])


def num(v):
    v = v.strip()
    return int(v) if v and v not in ("*", "X", "-") else None


def institutional_sensitivity(affected_towns, geoms, min_beds=20):
    """推計値に含まれる「施設入所者」の影響を定量化する。

    国勢調査の小地域集計は、病院の入院患者や施設入所者をその町丁の人口として数える。
    そのため「徒歩圏を失った高齢者」の推計には、そもそも自力でバス停まで歩かない
    入院患者が混ざりうる。20床以上の病院が立地する町丁の寄与を切り出し、
    推計の幅として公開する(隠さずに範囲を示す)。
    """
    beds = []
    path = ROOT / "data" / "hospitals.csv"
    if not path.exists():
        return {}
    with open(path, encoding="cp932") as f:
        for r in csv.DictReader(f):
            if not (r.get("緯度") and r.get("経度")):
                continue
            try:
                b = int(r.get("病床数") or 0)
            except ValueError:
                b = 0
            if b >= min_beds:
                beds.append((r["名称"], b, float(r["緯度"]), float(r["経度"])))

    by_key = {}
    for name, b, la, lo in beds:
        p = Point(*to_m(lo, la))
        for key, glist in geoms.items():
            if any(g.contains(p) for g in glist):
                cur = by_key.get(key, {"beds": 0, "names": []})
                cur["beds"] += b
                cur["names"].append(f"{name}({b}床)")
                by_key[key] = cur
                break

    hit = [t for t in affected_towns if t["key"] in by_key]
    contrib = sum(t["elderly_affected"] for t in hit)
    total = sum(t["elderly_affected"] for t in affected_towns)
    return {
        "institutional_min_beds": min_beds,
        "institutional_towns": [
            {"name": t["name"], "elderly_affected": t["elderly_affected"],
             "facilities": by_key[t["key"]]["names"], "beds": by_key[t["key"]]["beds"]}
            for t in sorted(hit, key=lambda x: -x["elderly_affected"])
        ],
        "elderly_affected_institutional": contrib,
        "elderly_affected_excl_institutional": total - contrib,
    }


def main():
    gtfs = ROOT / "data" / "gtfs"
    old4 = load_stops(gtfs / "old4routes")
    miyawaka = load_stops(gtfs / "miyawaka")
    chikuho = load_stops(gtfs / "chikuho")

    before_stops = old4 + miyawaka
    after_stops = miyawaka + chikuho
    cov_before = coverage_union(before_stops)
    cov_after = coverage_union(after_stops)

    # ---- 2020国調 小地域 年齢別人口 (KEY_CODE -> total, 65+) ----
    census = {}
    with open(ROOT / "data" / "age2020" / "tblT001082C40205.txt", encoding="cp932") as f:
        rows = list(csv.reader(f))
    for r in rows[2:]:  # 0:ヘッダ 1:和名ヘッダ
        key = r[0].strip()
        if len(key) < 9:  # 市全体行 (40205) はスキップ
            continue
        census[key] = {"name": r[3].strip(), "total": num(r[7]), "elderly": num(r[25])}

    # ---- 町丁界: KEY_CODE ごとにポリゴンを統合(飛び地対応) ----
    sf = shapefile.Reader(str(ROOT / "data" / "boundary" / "r2ka40205.shp"), encoding="cp932")
    fields = [f[0] for f in sf.fields[1:]]
    geoms = defaultdict(list)
    names = {}
    for srec, rec in zip(sf.shapes(), sf.records()):
        d = dict(zip(fields, rec))
        if d["HCODE"] == 8154:  # 水面調査区
            continue
        key = d["KEY_CODE"].strip()
        geoms[key].append(project(shp_shape(srec.__geo_interface__)))
        names[key] = d["S_NAME"].strip()

    towns = []
    features = []
    for key, glist in geoms.items():
        geom = unary_union(glist)
        area = geom.area
        if area <= 0:
            continue
        c = census.get(key) or {}
        name = c.get("name") or names[key]
        total = c.get("total") or 0
        elderly = c.get("elderly") or 0
        fb = geom.intersection(cov_before).area / area
        fa = geom.intersection(cov_after).area / area
        drop = fb - fa
        if fb >= 0.05 and fa < 0.02:
            cls = "lost"        # 徒歩圏が実質消滅
        elif drop >= 0.15:
            cls = "reduced"     # 大幅縮小
        elif fa >= 0.02:
            cls = "covered"
        else:
            cls = "never"
        t = {
            "key": key, "name": name,
            "pop_total": total, "pop_elderly": elderly,
            "frac_before": round(fb, 4), "frac_after": round(fa, 4),
            "class": cls,
            "elderly_affected": round(elderly * max(drop, 0)),  # 面積按分の推計
        }
        towns.append(t)
        features.append({"type": "Feature", "properties": t,
                         "geometry": mapping(unproject(geom.simplify(5)))})

    lost = [t for t in towns if t["class"] == "lost"]
    reduced = [t for t in towns if t["class"] == "reduced"]
    headline = {
        "walk_radius_m": WALK_M,
        "stops_before": len({(s["lat"], s["lon"]) for s in before_stops}),
        "stops_after": len({(s["lat"], s["lon"]) for s in after_stops}),
        "towns_total": len(towns),
        "towns_lost": len(lost),
        "towns_reduced": len(reduced),
        "elderly_in_lost_towns": sum(t["pop_elderly"] for t in lost),
        "elderly_affected_weighted": sum(t["elderly_affected"] for t in lost + reduced),
    }
    headline.update(institutional_sensitivity(lost + reduced, geoms))

    out = ROOT / "data" / "processed"
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "analysis.json", "w", encoding="utf-8") as f:
        json.dump({"headline": headline, "towns": towns}, f, ensure_ascii=False, indent=1)
    geojson = {"type": "FeatureCollection", "features": features}
    with open(out / "towns.geojson", "w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False)

    build_map(geojson, before_stops, after_stops, old4, headline)

    print(json.dumps(headline, ensure_ascii=False, indent=1))
    print("\n-- lost towns (徒歩圏消滅) --")
    for t in sorted(lost, key=lambda x: -x["pop_elderly"]):
        print(f"  {t['name']}: 65+ {t['pop_elderly']}人 (被覆 {t['frac_before']:.0%}→{t['frac_after']:.0%})")
    print("\n-- reduced towns (大幅縮小) --")
    for t in sorted(reduced, key=lambda x: -x["elderly_affected"]):
        print(f"  {t['name']}: 65+ {t['pop_elderly']}人, 推計影響{t['elderly_affected']}人 "
              f"(被覆 {t['frac_before']:.0%}→{t['frac_after']:.0%})")


CLASS_STYLE = {
    "lost":    {"color": "#c62828", "label": "徒歩圏消滅"},
    "reduced": {"color": "#ef6c00", "label": "大幅縮小"},
    "covered": {"color": "#2e7d32", "label": "現在も徒歩圏あり"},
    "never":   {"color": "#9e9e9e", "label": "もともと圏外"},
}


def build_map(geojson, before_stops, after_stops, old4, headline):
    m = folium.Map(location=[33.63, 130.69], zoom_start=12, tiles="cartodbpositron")

    def style(feat):
        p = feat["properties"]
        c = CLASS_STYLE[p["class"]]["color"]
        op = 0.55 if p["class"] in ("lost", "reduced") else 0.25
        return {"fillColor": c, "color": c, "weight": 0.5, "fillOpacity": op}

    folium.GeoJson(
        geojson, name="町丁別 徒歩圏の変化", style_function=style,
        tooltip=folium.GeoJsonTooltip(
            fields=["name", "pop_elderly", "frac_before", "frac_after"],
            aliases=["町丁", "65歳以上人口", "被覆率(廃止前)", "被覆率(現在)"]),
    ).add_to(m)

    after_set = {(s["lat"], s["lon"]) for s in after_stops}
    fg_old = folium.FeatureGroup(name="廃止バス停(旧4路線)")
    for s in old4:
        if (s["lat"], s["lon"]) in after_set:
            continue
        folium.CircleMarker([s["lat"], s["lon"]], radius=3, color="#c62828",
                            fill=True, fill_opacity=0.9,
                            tooltip=f"[廃止] {s['name']}").add_to(fg_old)
    fg_old.add_to(m)

    fg_new = folium.FeatureGroup(name="現行バス停")
    for s in after_stops:
        folium.CircleMarker([s["lat"], s["lon"]], radius=3, color="#1565c0",
                            fill=True, fill_opacity=0.9,
                            tooltip=s["name"]).add_to(fg_new)
    fg_new.add_to(m)

    title = (f"飯塚市コミュニティバス 2022年路線再編の影響:"
             f"バス停 {headline['stops_before']}→{headline['stops_after']}、"
             f"{headline['towns_lost']}町丁で徒歩圏({WALK_M}m)が消滅、"
             f"推計 約{headline['elderly_affected_weighted']:,}人の65歳以上が固定路線バスの徒歩圏を喪失(面積按分推計)")
    legend = "".join(
        f'<div><span style="display:inline-block;width:12px;height:12px;'
        f'background:{v["color"]};margin-right:6px"></span>{v["label"]}</div>'
        for v in CLASS_STYLE.values())
    m.get_root().html.add_child(folium.Element(
        f'<div style="position:fixed;top:10px;left:50px;right:50px;z-index:9999;'
        f'background:#fff;padding:10px 14px;border:2px solid #444;border-radius:6px;'
        f'font-size:15px;font-weight:bold">{title}</div>'
        f'<div style="position:fixed;bottom:20px;left:10px;z-index:9999;background:#fff;'
        f'padding:8px 12px;border:1px solid #999;border-radius:6px;font-size:13px">{legend}'
        f'<div style="margin-top:4px;color:#666;font-weight:normal">'
        f'出典: 飯塚市GTFS-JP(BODIK)、令和2年国勢調査小地域集計</div></div>'))
    folium.LayerControl().add_to(m)

    outdir = ROOT / "output"
    outdir.mkdir(exist_ok=True)
    m.save(str(outdir / "killer_map.html"))
    print(f"\nmap -> {outdir / 'killer_map.html'}")


if __name__ == "__main__":
    main()
