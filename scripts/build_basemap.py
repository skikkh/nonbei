"""Turn the cached Overpass extracts into site/data/base.json.

base.json = {"lo": [...], "hi": [...], "labels": [...]}
  feature = [class, minzoom, part, part, ...]   part = polyline-encoded world units
  label   = [type, minzoom, x, y, name, rank]
"lo" is drawn at zoom <= 12, "hi" at zoom >= 13 (together with the lazily
loaded street chunks from build_chunks.py). Class codes are shared with
site/src/map.js.
"""
import json
import math
import os
import re
import sys

from shapely.geometry import LineString, Point, box
from shapely.ops import polygonize, unary_union

sys.path.insert(0, os.path.dirname(__file__))
from features import Collector  # noqa: E402
from fetch_base import BBOX, WIDE  # noqa: E402
from geo import lines, minzoom_for_area, proj, relation_polygon, way_coords, way_polygon  # noqa: E402
from overpass import CACHE, query  # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "..", "site", "data")

S, Wd, N, E = BBOX
x0, y1 = proj(Wd, S)
x1, y0 = proj(E, N)
CLIP = box(x0, y0, x1, y1)
_ws, _ww, _wn, _we = WIDE
wx0, wy1 = proj(_ww, _ws)
wx1, wy0 = proj(_we, _wn)
WIDE_CLIP = box(wx0, wy0, wx1, wy1)
OUTER = WIDE_CLIP.difference(CLIP)  # context ring drawn only at zoom <= 12

# class codes (keep in sync with site/src/map.js) -------------------------------
WATER, PARK, FOREST, CEMETERY, GRASS, BUILDING = 1, 2, 3, 4, 5, 6
RIVER, STREAM = 10, 11
ROAD = {"motorway": 20, "trunk": 21, "primary": 22, "secondary": 23, "tertiary": 24,
        "residential": 25, "unclassified": 25, "living_street": 25, "pedestrian": 26,
        "service": 27, "footway": 28, "path": 28, "cycleway": 28, "track": 28,
        "corridor": 28, "steps": 29}
RAIL_JR, RAIL, SUBWAY, LIGHT = 40, 41, 42, 43
WARD, PREF = 50, 51
TUNNEL = 100
ROAD_MINZ = {20: 10, 21: 10, 22: 11, 23: 12, 24: 13, 25: 15, 26: 15, 27: 16, 28: 16, 29: 16}


def load(name):
    with open(os.path.join(CACHE, name + ".json"), encoding="utf-8") as f:
        return json.load(f)["elements"]


def is_tunnel(t):
    return t.get("tunnel") in ("yes", "building_passage", "covered") or t.get("location") == "underground"


# water ---------------------------------------------------------------------------

def sea_polygon(name="coastline", clip=CLIP):
    """Tokyo Bay from coastline ways (land on the left, water on the right)."""
    segs = [LineString(c) for c in (way_coords(e) for e in load(name)) if len(c) >= 2]
    coast = unary_union(segs)
    faces = list(polygonize(unary_union(segs + [clip.exterior])))
    sea = []
    for f in faces:
        if not clip.buffer(1).contains(f):
            continue
        pt = f.representative_point()
        best = min(lines(coast), key=lambda l: l.distance(pt))
        d = best.project(pt)
        a = best.interpolate(max(0, d - 0.5))
        b = best.interpolate(min(best.length, d + 0.5))
        # screen space (y down): the right-hand side of travel has cross > 0
        if (b.x - a.x) * (pt.y - a.y) - (b.y - a.y) * (pt.x - a.x) > 0:
            sea.append(f)
    return unary_union(sea)


def area_elements(name):
    """Polygons for ways and multipolygon relations, refetching clipped relations."""
    els = load(name)
    broken = [e["id"] for e in els if e["type"] == "relation" and relation_polygon(e) is None]
    fixed = {}
    if broken:
        ids = ",".join(map(str, broken))
        fixed = {e["id"]: e for e in query(f"[out:json][timeout:600];relation(id:{ids});out geom;",
                                             name=f"{name}_unclipped")["elements"]}
    for e in els:
        g = relation_polygon(fixed.get(e["id"], e)) if e["type"] == "relation" else way_polygon(e)
        if g is not None:
            yield e.get("tags", {}), g


def green_class(t):
    lu = t.get("landuse")
    if t.get("leisure") in ("park", "garden") or lu == "recreation_ground":
        return PARK
    if lu == "cemetery":
        return CEMETERY
    if lu == "grass":
        return GRASS
    return FOREST


def build(lo, hi):
    sea = sea_polygon()
    water = [g for _, g in area_elements("water")]
    lo.polygons(WATER, [sea] + water, tol=20, min_area=64 ** 2 * 6, minz=10)
    hi.polygons(WATER, [sea] + water, tol=1.2, min_area=60, minz=13)
    print("water done", file=sys.stderr)

    green = {}
    for t, g in area_elements("green"):
        green.setdefault(green_class(t), []).append(g)
    for cls, gs in green.items():
        lo.polygons(cls, gs, tol=24, min_area=64 ** 2 * 12)
        tol = 3.0 if cls == FOREST else 1.6
        hi.polygons(cls, gs, tol=tol, min_area=2500 if cls in (GRASS, FOREST) else 900, minz=13)
    print("green done", file=sys.stderr)

    for e in load("waterways"):
        t = e.get("tags", {})
        if t.get("tunnel") in ("yes", "culvert"):
            continue
        cls = RIVER if t.get("waterway") == "river" else STREAM
        c = way_coords(e)
        lo.line(cls, 11 if cls == RIVER else 12, c)
        hi.line(cls, 13, c)

    for name in ("roads_major",):
        for e in load(name):
            t = e.get("tags", {})
            hw = t.get("highway", "")
            cls = ROAD.get(hw.replace("_link", ""))
            if cls is None:
                continue
            link = hw.endswith("_link")
            code = cls + (TUNNEL if is_tunnel(t) else 0)
            c = way_coords(e)
            if not link:
                lo.line(code, ROAD_MINZ[cls], c)
            hi.line(code, ROAD_MINZ[cls] + (2 if link else 0), c)

    for e in load("rail"):
        t = e.get("tags", {})
        r, op = t.get("railway"), t.get("operator", "")
        if r == "subway":
            cls = SUBWAY
        elif r in ("light_rail", "monorail", "tram", "narrow_gauge"):
            cls = LIGHT
        elif re.search(r"JR|東日本旅客鉄道|東海旅客鉄道|Japan Railway", op) and "貨物" not in op:
            cls = RAIL_JR
        else:
            cls = RAIL
        code = cls + (TUNNEL if is_tunnel(t) else 0)
        c = way_coords(e)
        lo.line(code, 10, c)
        hi.line(code, 10, c)

    best = {}
    for e in load("admin"):
        cls = PREF if e["tags"].get("admin_level") == "4" else WARD
        for m in e.get("members", []):
            if m.get("type") == "way":
                best[m["ref"]] = max(best.get(m["ref"], 0), cls)
    done = set()
    for e in load("admin"):
        for m in e.get("members", []):
            if m.get("type") != "way" or m["ref"] in done:
                continue
            done.add(m["ref"])
            run = []
            for p in (m.get("geometry") or []) + [None]:
                if p is None:
                    if len(run) >= 2:
                        lo.line(best[m["ref"]], 10, run)
                        hi.line(best[m["ref"]], 13, run)
                    run = []
                else:
                    run.append(proj(p["lon"], p["lat"]))

    lo.flush_lines(tol=16)
    hi.flush_lines(tol=1.0)


# labels ---------------------------------------------------------------------------

HUBS = {"新宿", "渋谷", "池袋", "東京", "上野", "品川", "新橋", "秋葉原", "北千住", "立川", "八王子",
        "町田", "吉祥寺", "赤羽", "錦糸町", "大井町", "蒲田", "五反田", "恵比寿", "中野", "荻窪",
        "高円寺", "浅草", "有楽町", "神田", "浜松町", "大崎", "目黒", "日暮里", "大塚", "巣鴨", "国分寺",
        "三鷹", "府中", "調布", "西船橋", "川崎", "大宮", "武蔵小杉", "亀戸", "門前仲町", "押上",
        "下北沢", "三軒茶屋", "自由が丘", "中目黒", "高田馬場", "飯田橋", "四ツ谷", "御茶ノ水", "新小岩",
        "小岩", "金町", "京成立石", "十条", "王子", "西日暮里", "鶯谷", "御徒町", "銀座",
        "阿佐ケ谷", "西荻窪", "大森", "京急蒲田", "武蔵小山", "月島", "森下", "両国", "浅草橋", "茅場町"}


def norm_station(n):
    n = re.sub(r"[（(].*?[)）]", "", n).strip()
    return re.sub(r"駅$", "", n)


def station_labels():
    groups = []
    for e in load("stations"):
        t = e.get("tags", {})
        n = t.get("name")
        if not n:
            continue
        if t.get("railway") not in ("station", "halt") and not any(
                t.get(k) == "yes" for k in ("train", "subway", "light_rail", "monorail", "tram")):
            continue  # bus terminals and ferry piers also use public_transport=station
        if t.get("station") == "funicular" or t.get("building") or t.get("amenity") == "ferry_terminal" \
                or re.search(r"(駅舎|構内|改札口?|出口|船着場)$", n):
            continue
        if e["type"] == "node":
            lat, lon = e["lat"], e["lon"]
        elif e.get("center"):
            lat, lon = e["center"]["lat"], e["center"]["lon"]
        else:
            continue
        x, y = proj(lon, lat)
        nm = norm_station(n)
        sub = t.get("station") == "subway" or t.get("subway") == "yes"
        op = t.get("operator", "") or t.get("network", "")
        for g in groups:
            if g["name"] == nm and math.hypot(g["x"] - x, g["y"] - y) < 1300:  # ~600 m
                g["pts"].append((x, y, op, sub))
                break
        else:
            groups.append({"name": nm, "x": x, "y": y, "pts": [(x, y, op, sub)]})
    out = []
    for g in groups:
        surf = [p for p in g["pts"] if not p[3]] or g["pts"]
        x = sum(p[0] for p in surf) / len(surf)
        y = sum(p[1] for p in surf) / len(surf)
        if not CLIP.contains(Point(x, y)):
            continue
        n_ops = max(len({p[2] for p in g["pts"] if p[2]}), (len(g["pts"]) + 1) // 2)
        if g["name"] in HUBS:
            rank, minz = 3, 11
        elif n_ops >= 3:
            rank, minz = 2, 12
        elif n_ops == 2:
            rank, minz = 1, 13
        else:
            rank, minz = 0, 13
        out.append(["s", minz, round(x), round(y), g["name"], rank])
    return out


def place_labels():
    out = []
    for e in load("places"):
        t = e.get("tags", {})
        n, p = t.get("name"), t.get("place")
        if not n or p not in ("city", "town", "suburb"):
            continue  # quarter / neighbourhood labels live in the street chunks
        x, y = proj(e["lon"], e["lat"])
        minz, rank = {"city": (10, 3), "town": (11, 2), "suburb": (12, 2)}[p]
        out.append(["p", minz, round(x), round(y), n, rank])
    return out


def park_labels():
    out = []
    for t, g in area_elements("green"):
        n = t.get("name")
        if not n or t.get("leisure") not in ("park", "garden") or g.area < 40000:  # ~1 ha
            continue
        pt = g.representative_point()
        if CLIP.contains(pt):
            out.append(["g", max(13, minzoom_for_area(g.area, px2=12000)), round(pt.x), round(pt.y), n, 0])
    return out


def rail_class(t):
    r, op = t.get("railway"), t.get("operator", "")
    if r == "subway":
        return SUBWAY
    if r in ("light_rail", "monorail", "tram", "narrow_gauge"):
        return LIGHT
    if re.search(r"JR|東日本旅客鉄道|東海旅客鉄道|Japan Railway", op) and "貨物" not in op:
        return RAIL_JR
    return RAIL


def build_wide(lo):
    """Context outside the Tokyo box for the city-wide view."""
    lo.polygons(WATER, [sea_polygon("wide_coast", WIDE_CLIP)] + [g for _, g in area_elements("wide_water")],
                tol=20, min_area=64 ** 2 * 6, minz=9)
    for e in load("wide_rail"):
        t = e.get("tags", {})
        lo.line(rail_class(t) + (TUNNEL if is_tunnel(t) else 0), 9, way_coords(e))
    for e in load("wide_roads"):
        t = e.get("tags", {})
        cls = ROAD.get(t.get("highway", "").replace("_link", ""))
        if cls and not t.get("highway", "").endswith("_link"):
            lo.line(cls + (TUNNEL if is_tunnel(t) else 0), 10, way_coords(e))
    for e in load("wide_admin"):
        for m in e.get("members", []):
            run = []
            for p in (m.get("geometry") or []) + [None]:
                if p is None:
                    if len(run) >= 2:
                        lo.line(PREF, 9, run)
                    run = []
                else:
                    run.append(proj(p["lon"], p["lat"]))
    lo.flush_lines(tol=16)


def wide_labels():
    out = []
    for e in load("wide_places"):
        t = e.get("tags", {})
        if not t.get("name"):
            continue
        x, y = proj(e["lon"], e["lat"])
        if CLIP.contains(Point(x, y)) or not WIDE_CLIP.contains(Point(x, y)):
            continue
        out.append(["p", 10 if t.get("place") == "city" else 11, round(x), round(y), t["name"], 3 if t.get("place") == "city" else 2])
    for e in load("wide_stations"):
        n = norm_station(e.get("tags", {}).get("name", ""))
        if n not in WIDE_HUBS:
            continue
        x, y = proj(e["lon"], e["lat"])
        if not CLIP.contains(Point(x, y)) and WIDE_CLIP.contains(Point(x, y)):
            out.append(["s", 11, round(x), round(y), n, 3])
    # one label per hub name
    seen, uniq = set(), []
    for l in out:
        if (l[0], l[4]) in seen:
            continue
        seen.add((l[0], l[4]))
        uniq.append(l)
    return uniq


WIDE_HUBS = {"大宮", "浦和", "川口", "所沢", "川越", "横浜", "川崎", "武蔵小杉", "新横浜", "船橋", "西船橋", "千葉", "松戸", "柏",
             "相模大野", "本厚木", "海老名", "藤沢", "浦安", "舞浜", "津田沼", "海浜幕張"}


def main():
    os.makedirs(OUT, exist_ok=True)
    lo, hi = Collector(CLIP), Collector(CLIP)
    build(lo, hi)
    wide = Collector(OUTER)
    build_wide(wide)
    lo.items += wide.items
    labels = station_labels() + place_labels() + park_labels() + wide_labels()
    data = {"v": 3, "z0": 18, "bbox": [round(x0), round(y0), round(x1), round(y1)],
            "lo": sorted(lo.feats, key=lambda f: f[0]), "hi": sorted(hi.feats, key=lambda f: f[0]),
            "labels": labels}
    path = os.path.join(OUT, "base.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {path}: {os.path.getsize(path)/1e6:.2f} MB lo={len(lo.feats)} hi={len(hi.feats)} labels={len(labels)}",
          file=sys.stderr)


if __name__ == "__main__":
    main()
