"""Street-level chunks, one pair per z12 tile.

site/data/c/{x}_{y}.json  streets, minor place names, OSM drinking spots (loaded from z13)
site/data/b/{x}_{y}.json  buildings, footpaths, steps, service roads near spots (from z15)

chunk = {"o": [ox, oy], "f": [features], "l": [labels], "p": [pois]}
  feature = [class, minzoom, part, ...]   parts chain from the origin `o`
  label   = [type, minzoom, dx, dy, name, rank]          (dx, dy relative to `o`)
  poi     = [dx, dy, name, kind, osm, hours, floor, checked]
"""
import glob
import json
import os
import re
import sys
from collections import defaultdict

from shapely.geometry import box

sys.path.insert(0, os.path.dirname(__file__))
from build_basemap import BUILDING, CLIP, ROAD, ROAD_MINZ, TUNNEL, is_tunnel, load  # noqa: E402
from features import Collector  # noqa: E402
from geo import proj, relation_polygon, way_coords, way_polygon  # noqa: E402
from overpass import CACHE  # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "..", "site", "data")
CHUNK = 256 * 2 ** (18 - 12)      # streets: z12 tiles (~8 km)
SIZE = {"c": CHUNK, "b": CHUNK // 2}  # buildings: z13 tiles (~4 km), loaded only from z15


def key_of(x, y, size=CHUNK):
    return int(x // size), int(y // size)


def bounds_center(enc_feat_coords):
    xs, ys = zip(*enc_feat_coords)
    return (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2


class Chunks:
    """One Collector per (layer, chunk key); layer "c" = streets, "b" = detail."""

    def __init__(self):
        self.cols = {}

    def col(self, layer, k):
        if (layer, k) not in self.cols:
            x, y = k
            sz = SIZE[layer]
            clip = box(x * sz, y * sz, (x + 1) * sz, (y + 1) * sz).buffer(sz * 0.25)
            self.cols[(layer, k)] = Collector(clip, origin=(x * sz, y * sz), bucket=512)
        return self.cols[(layer, k)]

    def line(self, layer, cls, minz, coords):
        if len(coords) >= 2:
            self.col(layer, key_of(*bounds_center(coords), SIZE[layer])).line(cls, minz, coords)

    def poly(self, layer, cls, geom, minz, attr=0):
        c = geom.centroid
        self.col(layer, key_of(c.x, c.y, SIZE[layer])).polygons(cls, [geom], tol=0.8, min_area=40, minz=minz, union=False, attr=attr)


SKIP_FOOT = {"sidewalk", "crossing", "traffic_island"}
TYPE_HEIGHT = {"house": 7, "detached": 7, "residential": 10, "apartments": 14, "commercial": 14, "retail": 9,
               "office": 24, "hotel": 30, "public": 12, "school": 14, "warehouse": 8, "industrial": 9,
               "temple": 9, "shrine": 6, "roof": 4, "garage": 3, "shed": 3, "train_station": 12}


def building_height(t):
    """Height in metres from OSM tags (height, building:levels), else a typical one for the type."""
    for k in ("height", "building:height"):
        v = re.match(r"\s*([\d.]+)", t.get(k, ""))
        if v:
            try:
                return max(2, min(300, round(float(v.group(1)))))
            except ValueError:
                pass
    lv = re.match(r"\s*(\d+)", t.get("building:levels", ""))
    if lv:
        return max(3, min(300, round(int(lv.group(1)) * 3.3 + 1)))
    return TYPE_HEIGHT.get(t.get("building"), 8)


def main():
    ch = Chunks()
    seen = set()

    # tertiary + secondary/tertiary links
    for e in load("roads_tertiary"):
        t = e.get("tags", {})
        hw = t.get("highway", "")
        cls = ROAD.get(hw.replace("_link", ""))
        if cls is None or e["id"] in seen:
            continue
        seen.add(e["id"])
        ch.line("c", cls + (TUNNEL if is_tunnel(t) else 0), 13 if not hw.endswith("_link") else 14, way_coords(e))

    # residential streets, Tokyo-wide
    for path in sorted(glob.glob(os.path.join(CACHE, "streets_*.json"))):
        for e in json.load(open(path, encoding="utf-8"))["elements"]:
            if e["id"] in seen:
                continue
            seen.add(e["id"])
            t = e.get("tags", {})
            cls = ROAD.get(t.get("highway"))
            if cls is None:
                continue
            ch.line("c", cls + (TUNNEL if is_tunnel(t) else 0), 14, way_coords(e))

    # paths, service roads and buildings near curated spots
    nb = 0
    for path in sorted(glob.glob(os.path.join(CACHE, "spots_paths_*.json"))):
        for e in json.load(open(path, encoding="utf-8"))["elements"]:
            if e["id"] in seen:
                continue
            seen.add(e["id"])
            t = e.get("tags", {})
            if t.get("footway") in SKIP_FOOT or t.get("highway") == "service" and t.get("service") in ("parking_aisle", "drive-through"):
                continue
            cls = ROAD.get(t.get("highway"))
            if cls is None:
                continue
            ch.line("b", cls + (TUNNEL if is_tunnel(t) else 0), ROAD_MINZ[cls], way_coords(e))
    bseen = set()
    for path in sorted(glob.glob(os.path.join(CACHE, "spots_bld_*.json"))):
        for e in json.load(open(path, encoding="utf-8"))["elements"]:
            if (e["type"], e["id"]) in bseen:
                continue
            bseen.add((e["type"], e["id"]))
            g = relation_polygon(e) if e["type"] == "relation" else way_polygon(e)
            if g is None or g.is_empty:
                continue
            ch.poly("b", BUILDING, g, 16, building_height(e.get("tags", {})))
            nb += 1

    for (layer, _), col in ch.cols.items():
        col.flush_lines(tol=1.2 if layer == "c" else 0.8, merge=True, max_pts=120)

    labels = defaultdict(list)
    for e in load("places"):
        t = e.get("tags", {})
        n, p = t.get("name"), t.get("place")
        if not n or p not in ("quarter", "neighbourhood"):
            continue
        x, y = proj(e["lon"], e["lat"])
        k = key_of(x, y)
        labels[k].append(["p", 14 if p == "quarter" else 15, round(x - k[0] * CHUNK), round(y - k[1] * CHUNK), n, 1 if p == "quarter" else 0])

    pois = defaultdict(list)
    for e in load("pois"):
        t = e.get("tags", {})
        n = t.get("name") or t.get("name:ja")
        if not n:
            continue
        c = (e["lat"], e["lon"]) if e["type"] == "node" else (e.get("center", {}).get("lat"), e.get("center", {}).get("lon"))
        if c[0] is None:
            continue
        x, y = proj(c[1], c[0])
        a = t.get("amenity")
        shop = t.get("shop")
        cu = t.get("cuisine", "")
        if shop:
            kind = "酒屋"
        elif a == "bar":
            kind = "バー"
        elif a == "biergarten":
            kind = "ビアガーデン"
        elif re.search(r"yakitori|yakiton|motsu", cu):
            kind = "焼き鳥・もつ焼き"
        else:
            kind = "居酒屋"
        osm = e["type"][0] + str(e["id"])
        k = key_of(x, y)
        pois[k].append([round(x - k[0] * CHUNK), round(y - k[1] * CHUNK), n, kind, osm, t.get("opening_hours"),
                        t.get("level") or t.get("addr:floor"), t.get("check_date")])

    index = {}
    total = 0
    for layer in ("c", "b"):
        d = os.path.join(OUT, layer)
        os.makedirs(d, exist_ok=True)
        for f in glob.glob(os.path.join(d, "*.json")):
            os.remove(f)
        keys = {k for (l, k) in ch.cols if l == layer}
        if layer == "c":
            keys |= set(labels) | set(pois)
        for k in sorted(keys):
            col = ch.cols.get((layer, k))
            feats = sorted(col.feats, key=lambda f: f[0]) if col else []
            data = {"o": [k[0] * SIZE[layer], k[1] * SIZE[layer]], "f": feats}
            if layer == "c":
                data["l"] = labels.get(k, [])
                data["p"] = pois.get(k, [])
            if not feats and not data.get("l") and not data.get("p"):
                continue
            name = f"{k[0]}_{k[1]}"
            path = os.path.join(d, name + ".json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
            size = os.path.getsize(path)
            total += size
            index.setdefault(layer, {})[name] = size
    with open(os.path.join(OUT, "chunks.json"), "w") as f:
        json.dump(index, f, separators=(",", ":"))
    for layer, idx in index.items():
        print(f"{layer}: chunks={len(idx)} total={sum(idx.values())/1e6:.2f} MB biggest={max(idx.values())/1e6:.2f} MB", file=sys.stderr)
    print(f"buildings={nb} total={total/1e6:.2f} MB", file=sys.stderr)


if __name__ == "__main__":
    main()
