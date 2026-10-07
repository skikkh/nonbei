"""Sanity checks for data/spots.json. Prints problems; exits 1 if any are serious."""
import json
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
S, W, N, E = 35.50, 139.24, 35.84, 139.94


def main():
    d = json.load(open(os.path.join(ROOT, "data", "spots.json"), encoding="utf-8"))
    spots = d["spots"]
    ids = {s["id"] for s in spots}
    serious, notes = [], []
    for s in spots:
        tag = f'{s["id"]} ({s["name"]})'
        if not (S < s["lat"] < N and W < s["lng"] < E):
            serious.append(f"{tag}: outside the map area {s['lat']},{s['lng']}")
        if s.get("yokocho") and s["yokocho"] not in ids:
            serious.append(f"{tag}: unknown yokocho {s['yokocho']}")
        for k in ("name", "kind", "area", "social", "solo", "status"):
            if s.get(k) in (None, ""):
                serious.append(f"{tag}: missing {k}")
        ward = s.get("ward") or ""
        g = s.get("gsi") or ""
        if ward and g and ward not in g and s.get("geo") != "manual":
            notes.append(f"{tag}: ward {ward} but geocoded to {g}")
        near = s.get("near") or []
        if not near or near[0][1] > 1500:
            notes.append(f"{tag}: nearest station {near[0] if near else None}")
        if s.get("status") == "open" and not s.get("sources"):
            notes.append(f"{tag}: open but no source")
        for u in s.get("sources") or []:
            if not re.match(r"https?://", u):
                serious.append(f"{tag}: bad source {u}")
    for line in serious:
        print("ERROR", line)
    for line in notes:
        print("note ", line)
    print(f"{len(spots)} spots, {len(serious)} errors, {len(notes)} notes", file=sys.stderr)
    sys.exit(1 if serious else 0)


if __name__ == "__main__":
    main()
