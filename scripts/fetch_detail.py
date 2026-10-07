"""Fetch street-level detail from OpenStreetMap.

* residential streets Tokyo-wide, split by z12 tile (lazy-loaded chunks)
* drinking POIs (bar/pub/izakaya/alcohol shops) Tokyo-wide
* footways, service roads and buildings only around curated spots
"""
import hashlib
import json
import math
import sys

from overpass import query
from fetch_base import BBOX, HEAD

Z = 12


def tile_range(bbox=BBOX, z=Z):
    s, w, n, e = bbox
    def tx(lon):
        return int((lon + 180) / 360 * 2 ** z)
    def ty(lat):
        r = math.radians(lat)
        return int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** z)
    return range(tx(w), tx(e) + 1), range(ty(n), ty(s) + 1)


def tile_bbox(x, y, z=Z):
    def lat(yy):
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yy / 2 ** z))))
    return (lat(y + 1), x / 2 ** z * 360 - 180, lat(y), (x + 1) / 2 ** z * 360 - 180)


def fetch_streets():
    xs, ys = tile_range()
    for x in xs:
        for y in ys:
            s, w, n, e = tile_bbox(x, y)
            b = "%.5f,%.5f,%.5f,%.5f" % (s, w, n, e)
            query(f"""{HEAD}
way["highway"~"^(residential|unclassified|living_street|pedestrian)$"]({b});
out tags geom;""", name=f"streets_{x}_{y}")


def fetch_pois():
    b = "%.4f,%.4f,%.4f,%.4f" % BBOX
    query(f"""{HEAD}
(nwr["amenity"~"^(bar|pub|izakaya|biergarten)$"]({b});
 nwr["amenity"="restaurant"]["cuisine"~"izakaya|yakitori|kushikatsu|oden|yakiton|motsu"]({b});
 nwr["shop"~"^(alcohol|wine|beverages)$"]({b}););
out tags center;""", name="pois")


def fetch_around(points, radius_ways=700, radius_bld=520, tag="spots"):
    """points: list of (lat, lon). Fetched in batches to keep queries small."""
    for i in range(0, len(points), 12):
        batch = points[i:i + 12]
        ways = "".join(f'way["highway"~"^(footway|path|steps|service|cycleway|track|corridor)$"](around:{radius_ways},{la:.6f},{lo:.6f});' for la, lo in batch)
        blds = "".join(f'way["building"](around:{radius_bld},{la:.6f},{lo:.6f});relation["building"](around:{radius_bld},{la:.6f},{lo:.6f});' for la, lo in batch)
        h = hashlib.sha1(json.dumps([batch, radius_ways, radius_bld]).encode()).hexdigest()[:10]
        query(f"{HEAD}({ways});out tags geom;", name=f"{tag}_paths_{h}")
        query(f"{HEAD}({blds});out geom;", name=f"{tag}_bld_{h}")


if __name__ == "__main__":
    what = sys.argv[1:] or ["streets", "pois"]
    if "pois" in what:
        fetch_pois()
    if "streets" in what:
        fetch_streets()
    if "around" in what:
        pts = json.load(open(sys.argv[-1]))
        fetch_around([tuple(p) for p in pts])
