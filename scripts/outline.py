"""Outlines for yokocho: which alleys and buildings a drinking alley covers.

  python3 scripts/outline.py prepare ID[:HALF_M][@LAT,LNG] ...   # sheet per yokocho for choosing its parts
  python3 scripts/outline.py record ID ...             # work/outline/<id>/choice.json → data/outlines.json
  python3 scripts/outline.py check ID ...              # draw the outline over the sheet (check.png)
  python3 scripts/outline.py build                     # data/outlines.json → data/outline_shapes.json

`prepare` fetches the streets, paths and buildings within 260 m of the spot
(or of LAT,LNG when the spot itself is off) from OpenStreetMap and writes
work/outline/<id>/sheet.png, HALF_M metres (default 110) either side: every way is
labelled W<n>, every building B<n>, the map's own shops are blue dots (the
yokocho's member shops magenta), bars and restaurants in OSM orange, and a
grid gives pixel coordinates. parts.json maps the labels to OSM ids.

Someone (or an agent) who has read up on the place writes choice.json next to
the sheet, using the labels:

  {"ways": ["W12", "W40"], "buildings": ["B7"], "exclude": ["B90"],
   "px": [[[610, 420], [700, 430], [690, 520], [600, 515]]],
   "width": 4, "fronting": true, "note": "...", "sources": ["https://..."]}

  ways       alleys the yokocho runs along (buffered to `width` metres)
  buildings  buildings that belong to it (e.g. a market hall, a 飲み屋ビル)
  exclude    buildings to leave out even though they front a chosen alley
  px         polygons traced on the sheet in pixel coordinates, for parts
             OpenStreetMap does not draw (an arcade, the space under a viaduct)
  fronting   also take every building within 6 m of a chosen alley (default)

`record` converts the labels to OSM ids in data/outlines.json, so the outline
survives a re-run of `prepare`; `build` turns each entry into a polygon (the
pieces merged and smoothed) in data/outline_shapes.json, which build_spots.py
uses in place of the shape it finds by name.
"""
import json
import math
import os
import sys

from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

sys.path.insert(0, os.path.dirname(__file__))
from geo import enc_str, proj, unproj  # noqa: E402
from overpass import query  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), "..")
WORK = os.path.join(ROOT, "work", "outline")
OUTLINES = os.path.join(ROOT, "data", "outlines.json")
SHAPES = os.path.join(ROOT, "data", "outline_shapes.json")
R = 260
SIZE = 1400
ALLEY = ("footway", "path", "pedestrian", "steps", "service", "living_street", "corridor")


def all_spots():
    return json.load(open(os.path.join(ROOT, "data", "spots.json"), encoding="utf-8"))["spots"]


def mpu(lat):
    """metres per projected unit at this latitude (zoom-18 world units)."""
    return 40075016.686 * math.cos(math.radians(lat)) / (256 * 2 ** 18)


def around(lat, lng, r=R):
    ql = f"""[out:json][timeout:180];
(way["highway"](around:{r},{lat:.6f},{lng:.6f});
 way["building"](around:{r},{lat:.6f},{lng:.6f});
 relation["building"](around:{r},{lat:.6f},{lng:.6f});
 way["landuse"~"retail|commercial"](around:{r},{lat:.6f},{lng:.6f});
 way["amenity"="marketplace"](around:{r},{lat:.6f},{lng:.6f});
 way["man_made"="bridge"](around:{r},{lat:.6f},{lng:.6f});
 way["railway"~"rail|subway|light_rail"](around:{r},{lat:.6f},{lng:.6f});
 nwr["amenity"~"^(bar|pub|izakaya|restaurant)$"](around:{r},{lat:.6f},{lng:.6f}););
out tags geom;"""
    return query(ql, name=f"outline2_{lat:.5f}_{lng:.5f}_{r}")["elements"]


def geom_of(e):
    if e["type"] == "node":
        return Point(proj(e["lon"], e["lat"]))
    if e["type"] == "way":
        pts = [proj(p["lon"], p["lat"]) for p in e.get("geometry", []) if p]
        if len(pts) < 2:
            return None
        t = e.get("tags", {})
        closed = pts[0] == pts[-1] and len(pts) >= 4
        if closed and (t.get("building") or t.get("landuse") or t.get("amenity") == "marketplace" or t.get("area") == "yes"
                       or t.get("man_made") == "bridge"):
            p = Polygon(pts).buffer(0)
            return p if not p.is_empty else None
        return LineString(pts)
    if e["type"] == "relation":
        ps = []
        for m in e.get("members", []):
            g = m.get("geometry")
            if m.get("role") == "outer" and g and all(g) and len(g) >= 4:
                ps.append(Polygon([proj(p["lon"], p["lat"]) for p in g]).buffer(0))
        u = unary_union(ps) if ps else None
        return u if u is not None and not u.is_empty else None
    return None


def as_line(g):
    if g.geom_type == "LineString":
        return g
    if g.geom_type == "Polygon":
        return LineString(list(g.exterior.coords))
    return LineString(list(g.geoms[0].exterior.coords))


def sorted_parts(els):
    """The elements of a sheet, labelled the same way every time."""
    blds, ways, pois, areas = [], [], [], []
    for e in els:
        g = geom_of(e)
        if g is None:
            continue
        t = e.get("tags", {})
        if t.get("building") or e["type"] == "relation":
            blds.append((e, g))
        elif t.get("landuse") or t.get("amenity") == "marketplace" or t.get("man_made") == "bridge":
            areas.append((e, g))
        elif t.get("highway") or t.get("railway"):
            ways.append((e, as_line(g)))
        elif e["type"] == "node" or t.get("amenity"):
            pois.append((e, g))
    blds.sort(key=lambda eg: (eg[1].centroid.y, eg[1].centroid.x))
    return blds, ways, pois, areas


class View:
    def __init__(self, lat, lng, half_m):
        self.cx, self.cy = proj(lng, lat)
        self.k = mpu(lat)
        self.half_m = half_m
        self.scale = SIZE / (2 * half_m / self.k)  # px per projected unit

    def px(self, x, y):
        return ((x - self.cx) * self.scale + SIZE / 2, (y - self.cy) * self.scale + SIZE / 2)

    def unpx(self, X, Y):
        return ((X - SIZE / 2) / self.scale + self.cx, (Y - SIZE / 2) / self.scale + self.cy)


def fonts():
    from PIL import ImageFont
    import glob
    cands = ["/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf", "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
             "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf"]
    path = next((f for f in cands if os.path.exists(f)), None)
    if not path:
        path = (glob.glob("/usr/share/fonts/**/ipag*.ttf", recursive=True) + glob.glob("/usr/share/fonts/**/*.tt[fc]", recursive=True))[0]
    return ImageFont.truetype(path, 13), ImageFont.truetype(path, 11)


def render(s, els, view, outline=None):
    """Draw the sheet for spot `s`; with `outline` (projected polygons) draw that over it instead of the grid."""
    from PIL import Image, ImageDraw
    f_small, f_tiny = fonts()
    img = Image.new("RGB", (SIZE, SIZE), "white")
    dr = ImageDraw.Draw(img, "RGBA")
    blds, ways, pois, areas = sorted_parts(els)
    lng0, lat0 = unproj(view.cx, view.cy)
    parts = {"view": {"lat": round(lat0, 7), "lng": round(lng0, 7), "half_m": view.half_m, "size": SIZE},
             "ways": {}, "buildings": {}, "areas": {}, "pois": []}
    if outline is None:
        for v in range(100, SIZE, 100):
            dr.line([v, 0, v, SIZE], fill=(225, 232, 245), width=1)
            dr.line([0, v, SIZE, v], fill=(225, 232, 245), width=1)
            dr.text((v + 2, 2), str(v), fill=(140, 160, 200), font=f_tiny)
            dr.text((2, v + 2), str(v), fill=(140, 160, 200), font=f_tiny)
    for i, (e, g) in enumerate(areas, 1):
        lab = f"A{i}"
        t = e.get("tags", {})
        parts["areas"][lab] = {"id": e["type"][0] + str(e["id"]), "name": t.get("name", ""),
                               "kind": t.get("landuse") or t.get("amenity") or t.get("man_made")}
        col = (150, 150, 220) if t.get("man_made") == "bridge" else (60, 160, 60)
        for p in getattr(g, "geoms", [g]):
            if p.geom_type == "Polygon":
                dr.polygon([view.px(*c) for c in p.exterior.coords], outline=col, width=3)
        c = g.representative_point()
        x, y = view.px(c.x, c.y)
        dr.text((x - 10, y + 14), lab + (" " + t["name"][:16] if t.get("name") else ""), fill=col, font=f_small)
    for i, (e, g) in enumerate(blds, 1):
        lab = f"B{i}"
        parts["buildings"][lab] = e["type"][0] + str(e["id"])
        for p in getattr(g, "geoms", [g]):
            if p.geom_type == "Polygon":
                dr.polygon([view.px(*c) for c in p.exterior.coords], fill=(232, 232, 228), outline=(150, 150, 145))
        c = g.representative_point()
        x, y = view.px(c.x, c.y)
        if 0 <= x < SIZE and 0 <= y < SIZE and g.area * (view.k ** 2) > 25:
            n = e.get("tags", {}).get("name", "")
            dr.text((x - 8, y - 6), lab, fill=(110, 110, 110), font=f_tiny)
            if n:
                dr.text((x - 8, y + 5), n[:12], fill=(90, 90, 90), font=f_tiny)
    for i, (e, g) in enumerate(ways, 1):
        t = e.get("tags", {})
        lab = f"W{i}"
        parts["ways"][lab] = {"id": e["id"], "highway": t.get("highway") or t.get("railway"), "name": t.get("name", "")}
        rail = bool(t.get("railway"))
        col = (120, 120, 200) if rail else (200, 40, 40) if t.get("highway") in ALLEY else (40, 40, 40)
        dr.line([view.px(*c) for c in g.coords], fill=col, width=4 if not rail else 2)
        mid = g.interpolate(0.5, normalized=True)
        x, y = view.px(mid.x, mid.y)
        if -20 <= x < SIZE + 20 and -20 <= y < SIZE + 20:
            txt = lab + (f" {t['name']}" if t.get("name") else "")
            dr.rectangle([x - 2, y - 8, x + 8 * len(txt) + 4, y + 8], fill=(255, 255, 255, 220))
            dr.text((x, y - 7), txt, fill=col, font=f_small)
    for e, g in pois:
        c = g if g.geom_type == "Point" else g.centroid
        x, y = view.px(c.x, c.y)
        dr.ellipse([x - 3, y - 3, x + 3, y + 3], fill=(230, 120, 0))
        n = e.get("tags", {}).get("name", "")
        if n:
            dr.text((x + 4, y - 6), n[:14], fill=(200, 100, 0), font=f_tiny)
            lon, lat = unproj(c.x, c.y)
            parts["pois"].append([n, round(lat, 6), round(lon, 6)])
    # the map's own spots: this yokocho's shops in magenta, others blue
    for o in all_spots():
        x, y = view.px(*proj(o["lng"], o["lat"]))
        if not (0 <= x < SIZE and 0 <= y < SIZE) or o["id"] == s["id"]:
            continue
        col = (200, 0, 160) if o.get("yokocho") == s["id"] else (0, 90, 255)
        dr.ellipse([x - 5, y - 5, x + 5, y + 5], fill=col, outline="white")
        dr.text((x + 7, y - 7), o["name"][:14], fill=col, font=f_small)
    if outline:
        for p in outline:
            dr.polygon([view.px(*c) for c in p.exterior.coords], fill=(0, 120, 255, 70), outline=(0, 70, 200, 255), width=3)
    cx, cy = view.px(*proj(s["lng"], s["lat"]))
    dr.line([cx - 14, cy, cx + 14, cy], fill=(0, 90, 255), width=3)
    dr.line([cx, cy - 14, cx, cy + 14], fill=(0, 90, 255), width=3)
    px50 = 50 / view.k * view.scale
    dr.rectangle([24, SIZE - 60, 50 + px50, SIZE - 22], fill=(255, 255, 255, 230))
    dr.line([30, SIZE - 30, 30 + px50, SIZE - 30], fill=(0, 0, 0), width=4)
    dr.text((30, SIZE - 52), "50 m", fill=(0, 0, 0), font=f_small)
    dr.rectangle([14, 12, 760, 34], fill=(255, 255, 255, 230))
    dr.text((20, 16), f"{s['name']}  ({s['id']})  ↑北  中心の青い十字＝地図上の位置", fill=(0, 0, 0), font=f_small)
    return img, parts


def parse_ids(args):
    """ID[:HALF_M][@LAT,LNG] → (id, half_m or None, (lat, lng) or None)"""
    out = []
    for a in args:
        a, _, at = a.partition("@")
        sid, _, m = a.partition(":")
        c = tuple(float(v) for v in at.split(",")) if at else None
        out.append((sid, float(m) if m else None, c))
    return out


# ---------------------------------------------------------------- prepare
def prepare(args):
    S = {s["id"]: s for s in all_spots()}
    for sid, half_m, c in parse_ids(args):
        s = S[sid]
        lat, lng = c or (s["lat"], s["lng"])
        els = around(lat, lng)
        img, parts = render(s, els, View(lat, lng, half_m or 110.0))
        d = os.path.join(WORK, sid)
        os.makedirs(d, exist_ok=True)
        img.save(os.path.join(d, "sheet.png"))
        json.dump(parts, open(os.path.join(d, "parts.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print(sid, len(parts["buildings"]), "buildings", len(parts["ways"]), "ways", len(parts["pois"]), "pois", file=sys.stderr)


# ---------------------------------------------------------------- record
def load_outlines():
    return json.load(open(OUTLINES, encoding="utf-8")) if os.path.exists(OUTLINES) else {}


def spec_from_choice(sid):
    """work/outline/<id>/choice.json (sheet labels) → an outlines.json entry (OSM ids, lat/lng)."""
    d = os.path.join(WORK, sid)
    choice = json.load(open(os.path.join(d, "choice.json"), encoding="utf-8"))
    parts = json.load(open(os.path.join(d, "parts.json"), encoding="utf-8"))
    v = parts["view"]
    view = View(v["lat"], v["lng"], v["half_m"])
    spec = {k: choice[k] for k in ("width", "fronting", "max_building", "note", "sources", "skip") if k in choice}
    spec["center"] = [v["lat"], v["lng"]]
    spec["ways"] = [parts["ways"][w]["id"] for w in choice.get("ways", [])]
    spec["buildings"] = [parts["buildings"][b] for b in choice.get("buildings", [])]
    spec["buildings"] += [parts["areas"][a]["id"] for a in choice.get("areas", [])]
    spec["exclude"] = [parts["buildings"][b] for b in choice.get("exclude", [])]
    polys = []
    for ring in choice.get("px", []):
        ll = [unproj(*view.unpx(X, Y)) for X, Y in ring]
        polys.append([[round(la, 7), round(lo, 7)] for lo, la in ll])
    if polys:
        spec["polys"] = polys
    return {k: v for k, v in spec.items() if v not in ([], None)}


def record(ids):
    specs = load_outlines()
    for sid in ids or sorted(os.listdir(WORK)):
        if not os.path.exists(os.path.join(WORK, sid, "choice.json")):
            continue
        specs[sid] = spec_from_choice(sid)
        print(sid, {k: len(v) if isinstance(v, list) else v for k, v in specs[sid].items() if k not in ("note", "sources")}, file=sys.stderr)
    json.dump(specs, open(OUTLINES, "w", encoding="utf-8"), ensure_ascii=False, indent=1, sort_keys=True)


# ---------------------------------------------------------------- build
def by_ids(type_, ids):
    if not ids:
        return {}
    ql = f"[out:json][timeout:120];{type_}(id:{','.join(str(i) for i in sorted(ids))});out tags geom;"
    return {e["id"]: e for e in query(ql)["elements"]}


def outline_of(spec, s):
    k = mpu(s["lat"])
    lat0, lng0 = spec.get("center") or (s["lat"], s["lng"])
    ways = by_ids("way", spec.get("ways", []))
    bids = spec.get("buildings", [])
    chosen = list(by_ids("way", [int(b[1:]) for b in bids if b.startswith("w")]).values()) + \
        list(by_ids("relation", [int(b[1:]) for b in bids if b.startswith("r")]).values())
    width = spec.get("width", 4) / k
    alleys = [as_line(g) for g in (geom_of(e) for e in ways.values()) if g is not None]
    parts = [a.buffer(width / 2, cap_style=2) for a in alleys]
    parts += [g for g in (geom_of(e) for e in chosen) if g is not None]
    parts += [Polygon([proj(lo, la) for la, lo in ring]).buffer(0) for ring in spec.get("polys", [])]
    if spec.get("fronting", True) and alleys:
        skip = set(spec.get("exclude", [])) | set(bids)
        reach = max(Point(proj(lng0, lat0)).distance(Point(c)) for a in alleys for c in a.coords) * k + 30
        els = around(lat0, lng0) if reach <= R else around(lat0, lng0, int(math.ceil(reach / 50) * 50))
        for e in els:
            t = e.get("tags", {})
            if not (t.get("building") or e["type"] == "relation") or e["type"][0] + str(e["id"]) in skip:
                continue
            g = geom_of(e)
            if g is None or g.area * k * k > spec.get("max_building", 900):
                continue
            if any(g.distance(a) <= 6 / k for a in alleys):
                parts.append(g)
    if not parts:
        return None
    u = unary_union(parts).buffer(2.5 / k, join_style=2).buffer(-1.5 / k, join_style=2).simplify(0.6 / k)
    return [p for p in getattr(u, "geoms", [u]) if p.area * k * k > 30]


def check(ids):
    S = {s["id"]: s for s in all_spots()}
    specs = load_outlines()
    for sid in ids:
        s = S[sid]
        parts = json.load(open(os.path.join(WORK, sid, "parts.json"), encoding="utf-8"))
        spec = spec_from_choice(sid) if os.path.exists(os.path.join(WORK, sid, "choice.json")) else specs[sid]
        geoms = outline_of(spec, s) or []
        v = parts["view"]
        img, _ = render(s, around(v["lat"], v["lng"]), View(v["lat"], v["lng"], v["half_m"]), outline=geoms)
        img.save(os.path.join(WORK, sid, "check.png"))
        area = sum(p.area for p in geoms) * mpu(s["lat"]) ** 2
        print(f"{sid}: {len(geoms)} part(s), {area:.0f} m²", file=sys.stderr)


def build():
    specs = load_outlines()
    S = {s["id"]: s for s in all_spots()}
    out = {}
    for sid, spec in sorted(specs.items()):
        if sid not in S or spec.get("skip"):
            continue
        geoms = outline_of(spec, S[sid])
        if not geoms:
            print("no outline:", sid, file=sys.stderr)
            continue
        big = max(geoms, key=lambda p: p.area).representative_point()
        lon, lat = unproj(big.x, big.y)
        out[sid] = {"t": "poly", "p": [enc_str(list(p.exterior.coords), close=True)[0] for p in geoms],
                    "c": [round(lat, 7), round(lon, 7)],
                    "ll": [[[round(la, 7), round(lo, 7)] for lo, la in (unproj(*c) for c in p.exterior.coords)] for p in geoms]}
        area = sum(p.area for p in geoms) * mpu(S[sid]["lat"]) ** 2
        print(f"{sid}: {len(geoms)} part(s), {area:.0f} m²", file=sys.stderr)
    json.dump(out, open(SHAPES, "w", encoding="utf-8"), ensure_ascii=False, indent=0, sort_keys=True)
    print(f"{len(out)} outlines → {os.path.relpath(SHAPES, ROOT)}", file=sys.stderr)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "build"
    {"prepare": prepare, "record": record, "check": check}.get(cmd, lambda a: build())(sys.argv[2:])
