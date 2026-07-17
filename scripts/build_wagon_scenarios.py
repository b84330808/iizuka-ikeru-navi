# -*- coding: utf-8 -*-
"""Build reproducible one-wagon allocation scenarios for the LIFE TWIN demo.

The scenario is intentionally narrow:

* one additional wagon
* three round trips on weekdays
* six boarding points reused from one former community-bus corridor
* one medical stop on the same former corridor

For every former corridor, six boarding points are greedily selected to recover
the largest part of the 300 m walking area lost after the 2022 network change.
Recovered elderly population is area-weighted with the 2020 census, exactly as
in ``build_analysis.py``. This is an accessibility estimate, not a ridership
forecast.
"""
import csv
import json
import math
from collections import defaultdict
from pathlib import Path

from shapely.geometry import Point, shape
from shapely.ops import transform, unary_union

ROOT = Path(__file__).resolve().parent.parent
GTFS = ROOT / "data" / "gtfs"
WALK_M = 300
BOARDING_POINTS = 6
LAT0, LON0 = 33.64, 130.69
KX = 111320 * math.cos(math.radians(LAT0))
KY = 110540

ROUTES = {
    "SI": {
        "name": "庄内・飯塚コリドー",
        "short": "庄内・飯塚",
        "hospital": "飯塚記念病院入口",
        "color": "#b9ff66",
    },
    "KI": {
        "name": "頴田・飯塚コリドー",
        "short": "頴田・飯塚",
        "hospital": "頴田病院",
        "color": "#7de8ff",
    },
    "TC": {
        "name": "鎮西・飯塚コリドー",
        "short": "鎮西・飯塚",
        "hospital": "二瀬病院",
        "color": "#f1c75b",
    },
    "CI": {
        "name": "筑穂・飯塚コリドー",
        "short": "筑穂・飯塚",
        "hospital": "済生会病院",
        "color": "#ff8ab4",
    },
}


def to_m(lon, lat):
    return (lon - LON0) * KX, (lat - LAT0) * KY


def project(geom):
    return transform(lambda x, y, z=None: to_m(x, y), geom)


def distance_m(a, b):
    ax, ay = to_m(a["lon"], a["lat"])
    bx, by = to_m(b["lon"], b["lat"])
    return math.hypot(ax - bx, ay - by)


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def load_stops(feed):
    stops = {}
    for row in read_csv(feed / "stops.txt"):
        stops[row["stop_id"]] = {
            "id": row["stop_id"],
            "name": row["stop_name"],
            "lat": float(row["stop_lat"]),
            "lon": float(row["stop_lon"]),
        }
    return stops


def coverage(stops):
    return unary_union([
        Point(*to_m(stop["lon"], stop["lat"])).buffer(WALK_M)
        for stop in stops
    ])


def parse_time(value):
    hour, minute, second = (int(part) for part in value.split(":"))
    return hour * 60 + minute + second / 60


def format_time(minutes):
    whole = round(minutes)
    return f"{whole // 60:02d}:{whole % 60:02d}"


def canonical_route_stops(stop_ids, stops):
    """Collapse direction-specific GTFS stop ids at the same physical point."""
    result = []
    for stop_id in sorted(stop_ids):
        stop = stops[stop_id]
        match = next(
            (
                candidate
                for candidate in result
                if candidate["name"] == stop["name"] and distance_m(candidate, stop) <= 45
            ),
            None,
        )
        if match:
            match["member_ids"].append(stop_id)
        else:
            result.append({**stop, "member_ids": [stop_id]})
    return result


def main():
    old_dir = GTFS / "old4routes"
    old_stops = load_stops(old_dir)
    current_stops = list(load_stops(GTFS / "miyawaka").values())
    current_stops += list(load_stops(GTFS / "chikuho").values())
    with open(ROOT / "data" / "wagon" / "honami.geocoded.json", encoding="utf-8") as handle:
        wagon_points = json.load(handle)
    current_stops += [
        {
            "id": f"wagon:{name}",
            "name": name,
            "lat": point["lat"],
            "lon": point["lon"],
        }
        for name, point in wagon_points.items()
    ]
    current_coverage = coverage(current_stops)

    with open(ROOT / "data" / "processed" / "towns.geojson", encoding="utf-8") as handle:
        geojson = json.load(handle)
    target_towns = []
    for feature in geojson["features"]:
        properties = feature["properties"]
        if properties["class"] not in ("lost", "reduced"):
            continue
        geom = project(shape(feature["geometry"]))
        target_towns.append({
            "properties": properties,
            "geometry": geom,
            "area": geom.area,
            "baseline_fraction": geom.intersection(current_coverage).area / geom.area,
        })

    trips = {row["trip_id"]: row for row in read_csv(old_dir / "trips.txt")}
    stop_times = defaultdict(list)
    route_stop_ids = defaultdict(set)
    for row in read_csv(old_dir / "stop_times.txt"):
        trip = trips[row["trip_id"]]
        item = {
            "stop_id": row["stop_id"],
            "sequence": int(row["stop_sequence"]),
            "arrival": parse_time(row["arrival_time"]),
        }
        stop_times[row["trip_id"]].append(item)
        route_stop_ids[trip["route_id"]].add(row["stop_id"])
    for rows in stop_times.values():
        rows.sort(key=lambda item: item["sequence"])

    def estimate_recovery(candidate_coverage):
        uncovered_candidate = candidate_coverage.difference(current_coverage)
        total = 0.0
        by_town = {}
        for town in target_towns:
            p = town["properties"]
            recovered_area = town["geometry"].intersection(uncovered_candidate).area
            recovered = min(
                p["elderly_affected"],
                p["pop_elderly"] * recovered_area / town["area"],
            )
            if recovered >= 0.05:
                by_town[p["key"]] = recovered
            total += recovered
        return total, by_town

    remaining_gap, _ = estimate_recovery(coverage(old_stops.values()))
    scenarios = []
    for route_id, config in ROUTES.items():
        route_stops = canonical_route_stops(route_stop_ids[route_id], old_stops)
        hospital = next(stop for stop in route_stops if stop["name"] == config["hospital"])
        candidates = [stop for stop in route_stops if stop is not hospital]

        selected = []
        selected_coverage = None
        for _ in range(BOARDING_POINTS):
            best = None
            for stop in candidates:
                if stop in selected:
                    continue
                stop_buffer = Point(*to_m(stop["lon"], stop["lat"])).buffer(WALK_M)
                trial_coverage = (
                    stop_buffer
                    if selected_coverage is None
                    else selected_coverage.union(stop_buffer)
                )
                recovered, by_town = estimate_recovery(trial_coverage)
                if best is None or recovered > best["recovered"]:
                    best = {
                        "stop": stop,
                        "coverage": trial_coverage,
                        "recovered": recovered,
                        "by_town": by_town,
                    }
            if best is None:
                break
            selected.append(best["stop"])
            selected_coverage = best["coverage"]

        recovered, by_town = estimate_recovery(selected_coverage)
        individual_recovery = {}
        individual_by_town = {}
        for stop in selected:
            stop_buffer = Point(*to_m(stop["lon"], stop["lat"])).buffer(WALK_M)
            stop_recovery, stop_by_town = estimate_recovery(stop_buffer)
            individual_recovery[stop["id"]] = stop_recovery
            individual_by_town[stop["id"]] = stop_by_town

        relevant_trips = {
            trip_id: rows
            for trip_id, rows in stop_times.items()
            if trips[trip_id]["route_id"] == route_id
        }

        # Choose a real old-GTFS stop-to-hospital travel time for the resident card.
        itinerary_options = []
        hospital_ids = set(hospital["member_ids"])
        for stop in selected:
            origin_ids = set(stop["member_ids"])
            for trip_id, rows in relevant_trips.items():
                origins = [row for row in rows if row["stop_id"] in origin_ids]
                destinations = [row for row in rows if row["stop_id"] in hospital_ids]
                for origin in origins:
                    for destination in destinations:
                        if destination["sequence"] <= origin["sequence"]:
                            continue
                        morning_penalty = 0 if 8 * 60 <= destination["arrival"] <= 12 * 60 else 1
                        itinerary_options.append({
                            "stop": stop,
                            "trip_id": trip_id,
                            "departure": origin["arrival"],
                            "arrival": destination["arrival"],
                            "duration": round(destination["arrival"] - origin["arrival"]),
                            "priority": (
                                morning_penalty,
                                -individual_recovery[stop["id"]],
                                destination["arrival"],
                            ),
                        })
        itinerary = min(itinerary_options, key=lambda item: item["priority"])

        # Use the trip containing the most chosen points as the visual ordering.
        chosen_ids = set(hospital["member_ids"])
        for stop in selected:
            chosen_ids.update(stop["member_ids"])
        reference_trip_id, reference_rows = max(
            relevant_trips.items(),
            key=lambda item: sum(row["stop_id"] in chosen_ids for row in item[1]),
        )
        sequence_index = {
            row["stop_id"]: row["sequence"]
            for row in reference_rows
        }
        route_points = selected + [hospital]
        route_points.sort(
            key=lambda stop: min(
                (sequence_index.get(stop_id, 10_000) for stop_id in stop["member_ids"]),
                default=10_000,
            )
        )
        line_km = sum(
            distance_m(route_points[index - 1], route_points[index])
            for index in range(1, len(route_points))
        ) / 1000

        trip_durations = [
            rows[-1]["arrival"] - rows[0]["arrival"]
            for rows in relevant_trips.values()
            if len(rows) > 1
        ]
        affected_towns = sorted(
            (
                {
                    "key": key,
                    "name": next(
                        town["properties"]["name"]
                        for town in target_towns
                        if town["properties"]["key"] == key
                    ),
                    "recovered": round(value),
                }
                for key, value in by_town.items()
                if value >= 1
            ),
            key=lambda item: -item["recovered"],
        )
        example_recovery = individual_by_town[itinerary["stop"]["id"]]
        resident_key, resident_value = max(example_recovery.items(), key=lambda item: item[1])
        resident_record = next(
            town
            for town in target_towns
            if town["properties"]["key"] == resident_key
        )
        resident_town = {
            "key": resident_key,
            "name": resident_record["properties"]["name"],
            "recovered": round(resident_value),
        }
        scenarios.append({
            "id": route_id,
            "name": config["name"],
            "shortName": config["short"],
            "color": config["color"],
            "hospital": {
                "name": hospital["name"].replace("入口", ""),
                "stopName": hospital["name"],
                "lat": hospital["lat"],
                "lon": hospital["lon"],
            },
            "recoveredElderly": round(recovered),
            "recoveredShare": round(recovered / remaining_gap * 100, 1),
            "recoveredTowns": sum(item["recovered"] >= 10 for item in affected_towns),
            "selectedStops": [
                {
                    "name": stop["name"],
                    "lat": stop["lat"],
                    "lon": stop["lon"],
                    "individualRecovery": round(individual_recovery[stop["id"]]),
                }
                for stop in selected
            ],
            "townRecovery": {
                key: round(value)
                for key, value in by_town.items()
                if round(value) > 0
            },
            "topTowns": affected_towns[:6],
            "routeCoordinates": [
                [round(stop["lon"], 7), round(stop["lat"], 7)]
                for stop in route_points
            ],
            "corridorKm": round(line_km, 1),
            "oldGtfsDurationRange": [
                round(min(trip_durations)),
                round(max(trip_durations)),
            ],
            "referenceTripId": reference_trip_id,
            "residentExample": {
                "townKey": resident_town["key"],
                "town": resident_town["name"],
                "stop": itinerary["stop"]["name"],
                "hospital": hospital["name"].replace("入口", ""),
                "departure": format_time(itinerary["departure"]),
                "arrival": format_time(itinerary["arrival"]),
                "durationMinutes": itinerary["duration"],
                "beforeCoveragePercent": round(resident_record["baseline_fraction"] * 100, 1),
                "afterRecoveredElderly": resident_town["recovered"],
                "sourceTripId": itinerary["trip_id"],
            },
        })

    scenarios.sort(key=lambda scenario: -scenario["recoveredElderly"])
    for index, scenario in enumerate(scenarios, start=1):
        scenario["rank"] = index
        scenario["recommended"] = index == 1
    assert len(scenarios) == len(ROUTES)
    assert all(len(scenario["selectedStops"]) == BOARDING_POINTS for scenario in scenarios)
    assert all(
        scenarios[index - 1]["recoveredElderly"] >= scenarios[index]["recoveredElderly"]
        for index in range(1, len(scenarios))
    )

    result = {
        "meta": {
            "generated": "2026-07-18",
            "scenario": "追加ワゴン1台・平日3往復・旧停留所6地点＋医療拠点",
            "walkRadiusM": WALK_M,
            "boardingPoints": BOARDING_POINTS,
            "baselineAffectedElderly": 3484,
            "remainingGapElderly": round(remaining_gap),
            "method": "現行固定路線と穂波・菰田エリアワゴンで未被覆の300m徒歩圏を、旧停留所から再接続。2020年国勢調査65歳以上人口を町丁面積で按分。",
            "warning": "アクセシビリティ改善の比較試算。利用者数・収支・公式運行計画ではありません。",
            "sources": [
                "飯塚市GTFS-JP（再編前4路線・現行2路線）",
                "飯塚市 穂波・菰田地区エリアワゴン時刻表",
                "令和2年国勢調査 小地域集計",
            ],
        },
        "scenarios": scenarios,
    }
    output = ROOT / "app" / "wagon-scenarios.json"
    with open(output, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
    print(f"wrote {output}")
    for scenario in scenarios:
        print(
            f"{scenario['rank']}. {scenario['shortName']}: "
            f"{scenario['recoveredElderly']:,}人 / "
            f"{scenario['recoveredTowns']}町丁 / "
            f"{', '.join(stop['name'] for stop in scenario['selectedStops'])}"
        )


if __name__ == "__main__":
    main()
