"""Cluster centres of the curated spots, for fetching street detail around them.

usage: python3 scripts/spot_points.py > .cache/points.json
"""
import json
import math
import os
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
CELL = 0.0035  # ~350 m: spots in the same cell share one detail query


def main():
    spots = json.load(open(os.path.join(ROOT, "data", "spots.json"), encoding="utf-8"))["spots"]
    cells = {}
    for s in spots:
        k = (math.floor(s["lat"] / CELL), math.floor(s["lng"] / CELL))
        cells.setdefault(k, []).append((s["lat"], s["lng"]))
    pts = []
    for v in cells.values():
        pts.append([round(sum(p[0] for p in v) / len(v), 6), round(sum(p[1] for p in v) / len(v), 6)])
    pts.sort()
    json.dump(pts, sys.stdout)
    print(f"{len(spots)} spots -> {len(pts)} points", file=sys.stderr)


if __name__ == "__main__":
    main()
