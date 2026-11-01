"""Assemble the static site in dist/site/ for GitHub Pages.

dist/site/index.html        the page (CSS and JS inlined)
dist/site/data/spots.json   complete merged data, retained for other consumers
dist/site/data/spots-index.json and details/   map index and lazy-loaded details
dist/site/data/…            basemap and street/building chunks from site/data/
dist/site/icon.svg, apple-touch-icon.png, og.png (when present in site/static/)
usage: python3 scripts/build_site.py [out_dir]
"""
import json
import hashlib
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(__file__))

ROOT = os.path.join(os.path.dirname(__file__), "..")
SRC = os.path.join(ROOT, "site", "src")
DATA = os.path.join(ROOT, "site", "data")
STATIC = os.path.join(ROOT, "site", "static")
VENDOR = os.path.join(ROOT, "site", "vendor")

# Everything needed for the map, search, filters, sorting and opening-hours lamps.
INDEX_FIELDS = ("id", "name", "kana", "en", "aliases", "kind", "area", "ward", "region", "address", "station",
                "lat", "lng", "shape", "social", "solo", "hiru", "english", "tags", "status", "status_note",
                "budget", "budget_min", "budget_max", "cash_only", "week", "catch", "yokocho")
DETAIL_BUCKETS = 64

KEEP = ("id", "name", "kana", "en", "aliases", "kind", "area", "ward", "region", "address", "station", "near", "lat", "lng", "shape",
        "social", "solo", "hiru", "english", "tags", "status", "since", "desc", "talk", "tips", "price", "budget",
        "budget_min", "budget_max", "checked", "sources", "geo", "yokocho", "where", "members")


def read(*p):
    with open(os.path.join(*p), encoding="utf-8") as f:
        return f.read()


def site_spot(s, info):
    o = {k: s[k] for k in KEEP if s.get(k) not in (None, "", [])}
    i = dict(info or {})
    for k in ("desc", "talk", "tips", "price", "since"):
        if i.get("fix_" + k):
            o[k] = i.pop("fix_" + k)
    if i.get("sources_add"):
        o["sources"] = o.get("sources", []) + [u for u in i.pop("sources_add") if u not in o.get("sources", [])]
    if s.get("hours") and not i.get("hours"):
        i["hours"] = s["hours"]
    o.update({k: v for k, v in i.items() if v not in (None, "", [], {})})
    return o


def split_spots(payload):
    buckets = [{} for _ in range(DETAIL_BUCKETS)]
    index = []
    for spot in payload["spots"]:
        bucket = hashlib.sha256(spot["id"].encode()).digest()[0] % DETAIL_BUCKETS
        buckets[bucket][spot["id"]] = spot
        summary = {k: spot[k] for k in INDEX_FIELDS if k in spot}
        # Search indexes menu names, and the list uses the first description sentence as a fallback.
        if spot.get("menu"):
            summary["menu"] = [{"n": m.get("n")} for m in spot["menu"]]
        if not spot.get("catch") and spot.get("desc"):
            desc = spot["desc"]
            summary["desc"] = desc.split("。", 1)[0] + ("。" if "。" in desc else "")
        summary["_bucket"] = bucket
        index.append(summary)
    encoded = [json.dumps(b, ensure_ascii=False, separators=(",", ":")).encode("utf-8") for b in buckets]
    version = hashlib.sha256(b"".join(encoded)).hexdigest()[:20]
    return dict(payload, spots=index, detail_version=version), encoded


def build(out=os.path.join(ROOT, "dist", "site")):
    import build_info
    build_info.main()   # data/info.json from spots + shop pages + review summaries
    spots = json.loads(read(ROOT, "data", "spots.json"))
    info_path = os.path.join(ROOT, "data", "info.json")
    info = json.loads(read(info_path)) if os.path.exists(info_path) else {}
    chunks = json.loads(read(DATA, "chunks.json"))
    payload = {
        "spots": [site_spot(s, info.get(s["id"])) for s in spots["spots"]],
        "regions": spots.get("regions", []),
        "updated": spots.get("updated"),
        "accuracy": spots.get("accuracy"),
        "chunks": chunks,
    }
    index, details = split_spots(payload)
    page = read(SRC, "page.html")
    page = (page.replace("/*MAPLIBRE_CSS*/", read(VENDOR, "maplibre-gl.css"))
                .replace("/*APP_CSS*/", read(SRC, "style.css"))
                .replace("/*ATLAS_JS*/", read(SRC, "atlas.js"))
                .replace("/*APP_JS*/", read(SRC, "app.js")))
    if os.path.isdir(os.path.join(out, "data")):
        shutil.rmtree(os.path.join(out, "data"))
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "index.html"), "w", encoding="utf-8") as f:
        f.write(page)
    os.makedirs(os.path.join(out, "vendor"), exist_ok=True)
    shutil.copyfile(os.path.join(VENDOR, "maplibre-gl.js"), os.path.join(out, "vendor", "maplibre-gl.js"))
    shutil.copytree(DATA, os.path.join(out, "data"), ignore=shutil.ignore_patterns("chunks.json"))
    with open(os.path.join(out, "data", "spots.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(out, "data", "spots-index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))
    detail_dir = os.path.join(out, "data", "details", index["detail_version"])
    os.makedirs(detail_dir, exist_ok=True)
    for n, data in enumerate(details):
        with open(os.path.join(detail_dir, f"{n:02x}.json"), "wb") as f:
            f.write(data)
    if os.path.isdir(STATIC):
        for name in os.listdir(STATIC):
            src = os.path.join(STATIC, name)
            if os.path.isfile(src):
                shutil.copy(src, os.path.join(out, name))
            elif os.path.isdir(src):
                shutil.copytree(src, os.path.join(out, name), dirs_exist_ok=True)
    open(os.path.join(out, ".nojekyll"), "w").close()
    kb = lambda p: os.path.getsize(os.path.join(out, p)) / 1e3  # noqa: E731
    print(f"index.html {kb('index.html'):.0f} KB, data/spots-index.json {kb('data/spots-index.json'):.0f} KB, data/spots.json {kb('data/spots.json'):.0f} KB", file=sys.stderr)


if __name__ == "__main__":
    build(*sys.argv[1:2])
