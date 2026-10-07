"""Geometry helpers shared by the basemap builders.

Coordinates are projected to Web Mercator "world units" at zoom 18
(256 * 2**18 px across the world), so one unit is about 0.48 m in Tokyo.
The browser renderer uses the same space, so it never has to do trig per vertex.
"""
import math

from shapely.geometry import LineString, MultiPolygon, Polygon
from shapely.ops import polygonize, unary_union

Z0 = 18
W = 256 * 2 ** Z0


def proj(lon, lat):
    x = (lon + 180) / 360 * W
    s = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * W
    return x, y


def unproj(x, y):
    lon = x / W * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / W))))
    return lon, lat


def way_coords(el):
    g = el.get("geometry") or []
    return [proj(p["lon"], p["lat"]) for p in g if p]


def way_polygon(el):
    c = way_coords(el)
    if len(c) < 4 or c[0] != c[-1]:
        return None
    p = Polygon(c)
    if not p.is_valid:
        p = p.buffer(0)
    return p if not p.is_empty else None


def relation_polygon(el):
    """Assemble a multipolygon relation (members carry `geometry`)."""
    outers, inners = [], []
    for m in el.get("members", []):
        if m.get("type") != "way":
            continue
        g = m.get("geometry")
        if not g or any(p is None for p in g):
            return None  # clipped or incomplete; caller refetches unclipped
        c = [proj(p["lon"], p["lat"]) for p in g]
        if len(c) < 2:
            continue
        (inners if m.get("role") == "inner" else outers).append(LineString(c))
    if not outers:
        return None
    try:
        outer = unary_union(list(polygonize(unary_union(outers))))
        if inners:
            inner = unary_union(list(polygonize(unary_union(inners))))
            outer = outer.difference(inner)
    except Exception:
        return None
    if outer.is_empty:
        return None
    return outer


def polys(geom):
    """Yield Polygons from any (multi)polygon/collection."""
    if geom is None or geom.is_empty:
        return
    if isinstance(geom, Polygon):
        yield geom
    elif isinstance(geom, MultiPolygon):
        yield from geom.geoms
    elif hasattr(geom, "geoms"):
        for g in geom.geoms:
            yield from polys(g)


def lines(geom):
    if geom is None or geom.is_empty:
        return
    if isinstance(geom, LineString):
        yield geom
    elif hasattr(geom, "geoms"):
        for g in geom.geoms:
            yield from lines(g)


def enc(coords, close=False):
    """Delta-encode a coordinate sequence as a flat int list."""
    out, px, py = [], 0, 0
    pts = list(coords)
    if close and len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]  # renderer closes rings itself
    for x, y in pts:
        ix, iy = int(round(x)), int(round(y))
        if out and ix == px and iy == py:
            continue
        out += [ix - px, iy - py]
        px, py = ix, iy
    return out


def enc_polygon(p):
    parts = [enc(p.exterior.coords, close=True)]
    parts += [enc(r.coords, close=True) for r in p.interiors]
    return [q for q in parts if len(q) >= 6]


def _zz(v, out):
    v = ~(v << 1) if v < 0 else (v << 1)
    while v >= 0x20:
        out.append(chr((0x20 | (v & 0x1F)) + 63))
        v >>= 5
    out.append(chr(v + 63))


def enc_str(coords, close=False, start=(0, 0)):
    """Google-polyline style string of delta-encoded world units.

    Deltas continue from `start` (the previous part's last point, or a chunk
    origin), so consecutive parts of one feature stay short. Returns
    (string, n_points, last_point). Decoded by dec() in site/src/map.js.
    """
    pts = list(coords)
    if close and len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]
    out, (px, py), n = [], start, 0
    for x, y in pts:
        ix, iy = int(round(x)), int(round(y))
        if n and ix == px and iy == py:
            continue
        _zz(ix - px, out)
        _zz(iy - py, out)
        px, py, n = ix, iy, n + 1
    return "".join(out), n, (px, py)


def split_coords(coords, max_pts=160):
    """Cut long lines into overlapping runs so tiles can cull them."""
    c = list(coords)
    if len(c) <= max_pts:
        return [c]
    return [c[i:i + max_pts + 1] for i in range(0, len(c) - 1, max_pts)]


def minzoom_for_area(area, px2=40, lo=10, hi=17):
    """Smallest zoom at which a polygon covers at least `px2` square pixels."""
    if area <= 0:
        return hi
    z = Z0 - math.log(area / px2, 4)
    return int(max(lo, min(hi, math.ceil(z))))
