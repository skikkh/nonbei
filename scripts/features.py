"""Collect, generalise and encode map features for the browser renderer.

A feature is [class, minzoom, part, part, ...]. Parts are polyline strings
whose deltas run on from the previous part (the first part starts at the
collector's origin). With `bucket` set, nearby items of the same class and
minzoom are packed into one feature, which keeps per-feature overhead low
for dense layers such as streets and buildings.
"""
from collections import defaultdict

import shapely
from shapely.geometry import LineString, MultiLineString, box
from shapely.geometry.polygon import orient
from shapely.ops import linemerge, unary_union

from geo import enc_str, lines, minzoom_for_area, polys, split_coords

GRID = 256 * 2 ** 4  # z14 tile in world units (~1.95 km): polygon split size


def _grid_split(p, cell=GRID):
    minx, miny, maxx, maxy = p.bounds
    if maxx - minx <= cell and maxy - miny <= cell:
        yield p
        return
    for gx in range(int(minx // cell), int(maxx // cell) + 1):
        for gy in range(int(miny // cell), int(maxy // cell) + 1):
            c = box(gx * cell, gy * cell, (gx + 1) * cell, (gy + 1) * cell)
            if c.intersects(p):
                yield from polys(p.intersection(c))


class Collector:
    def __init__(self, clip, origin=(0, 0), bucket=None):
        self.clip = clip
        self.origin = origin
        self.bucket = bucket
        self.items = []          # (cls, minz, [coords, ...], is_polygon)
        self._lines = defaultdict(list)

    # polygons ---------------------------------------------------------------
    def polygons(self, cls, geoms, tol, min_area, minz=None, union=True, px2=40):
        geoms = [g for g in geoms if g is not None and not g.is_empty]
        if not geoms:
            return
        if union:
            try:
                g = unary_union([shapely.make_valid(x) for x in geoms])
            except Exception:
                g = unary_union([x.buffer(0) for x in geoms])
            geoms = [g]
        for g in geoms:
            if not self.clip.contains(g):
                g = g.intersection(self.clip)
            for p in polys(g):
                if p.area < min_area:
                    continue
                z = minz if minz is not None else minzoom_for_area(p.area, px2=px2)
                for piece in _grid_split(p):
                    s = shapely.simplify(piece, tol, preserve_topology=True)
                    for q in polys(s):
                        if q.area < min_area / 4:
                            continue
                        q = orient(q, 1.0)  # holes run the other way: the renderer fills "nonzero"
                        rings = [list(q.exterior.coords)] + [list(r.coords) for r in q.interiors]
                        self.items.append((cls, z, rings, True))

    # lines -----------------------------------------------------------------
    def line(self, cls, minz, coords):
        if len(coords) >= 2:
            self._lines[(cls, minz)].append(LineString(coords))

    def flush_lines(self, tol, merge=True, max_pts=160):
        for (cls, minz), ls in sorted(self._lines.items()):
            g = MultiLineString(ls)
            if merge:
                g = linemerge(g)
            if not self.clip.contains(g):
                g = g.intersection(self.clip)
            for l in lines(g):
                s = shapely.simplify(l, tol, preserve_topology=False)
                for m in lines(s):
                    for run in split_coords(m.coords, max_pts):
                        if len(run) >= 2:
                            self.items.append((cls, minz, [run], False))
        self._lines.clear()

    # encoding --------------------------------------------------------------
    @property
    def feats(self):
        groups = defaultdict(list)
        for i, (cls, z, parts, poly) in enumerate(self.items):
            if self.bucket:
                xs = [c[0] for c in parts[0]]
                ys = [c[1] for c in parts[0]]
                key = (cls, z, int((min(xs) + max(xs)) / 2 // self.bucket), int((min(ys) + max(ys)) / 2 // self.bucket))
            else:
                key = (cls, z, i)
            groups[key].append((parts, poly))
        out = []
        for key in sorted(groups):
            cls, z = key[0], key[1]
            cur = self.origin
            strs = []
            for parts, poly in groups[key]:
                for c in parts:
                    s, n, last = enc_str(c, close=poly, start=cur)
                    if n >= (3 if poly else 2):
                        strs.append(s)
                        cur = last
            if strs:
                out.append([cls, z] + strs)
        return out
