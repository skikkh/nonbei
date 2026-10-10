"""Fetch street detail (paths, service roads, buildings) around spots that have none yet.

Compares the current spot cells (see spot_points.py) with the points already
fetched (.cache/points*.json), fetches only the new ones and appends them to
.cache/points_added.json. Run build_chunks.py afterwards.
usage: NONBEI_CACHE=... python3 scripts/fetch_new_detail.py
"""
import glob
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from fetch_detail import fetch_around  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), "..")
CELL = 0.0035
NEAR = 220  # metres: a cell centre this close to a fetched point is already covered (buildings reach 520 m)


def meters(a, b):
    return math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 111320 * math.cos(math.radians(a[0])))


def main():
    spots = json.load(open(os.path.join(ROOT, "data", "spots.json"), encoding="utf-8"))["spots"]
    cells = {}
    for s in spots:
        k = (math.floor(s["lat"] / CELL), math.floor(s["lng"] / CELL))
        cells.setdefault(k, []).append((s["lat"], s["lng"]))
    want = [(round(sum(p[0] for p in v) / len(v), 6), round(sum(p[1] for p in v) / len(v), 6)) for v in cells.values()]
    have = []
    for f in glob.glob(os.path.join(ROOT, ".cache", "points*.json")):
        have += [tuple(p) for p in json.load(open(f))]
    # a spot more than NEAR from every fetched point needs its own fetch
    todo = sorted({p for p in want if all(meters(p, h) > NEAR for h in have)})
    print(f"{len(want)} cells, {len(have)} fetched points, {len(todo)} to fetch", file=sys.stderr)
    if todo:
        fetch_around(todo)
        path = os.path.join(ROOT, ".cache", "points_added.json")
        old = json.load(open(path)) if os.path.exists(path) else []
        json.dump(old + [list(p) for p in todo], open(path, "w"))


if __name__ == "__main__":
    main()
