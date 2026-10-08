"""Assemble the static site in dist/site/ for GitHub Pages.

dist/site/index.html        the page (CSS and JS inlined)
dist/site/data/spots.json   spots merged with data/info.json, plus the chunk index
dist/site/data/…            basemap and street/building chunks from site/data/
dist/site/icon.svg, apple-touch-icon.png, og.png (when present in site/static/)
usage: python3 scripts/build_site.py [out_dir]
"""
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(__file__))

ROOT = os.path.join(os.path.dirname(__file__), "..")
SRC = os.path.join(ROOT, "site", "src")
DATA = os.path.join(ROOT, "site", "data")
STATIC = os.path.join(ROOT, "site", "static")
VENDOR = os.path.join(ROOT, "site", "vendor")

KEEP = ("id", "name", "kana", "en", "kind", "area", "ward", "region", "address", "station", "near", "lat", "lng", "shape",
        "social", "solo", "hiru", "english", "tags", "status", "since", "desc", "talk", "tips", "price", "budget",
        "budget_min", "budget_max", "checked", "sources", "geo")


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
    shutil.copytree(DATA, os.path.join(out, "data"), ignore=shutil.ignore_patterns("chunks.json"))
    with open(os.path.join(out, "data", "spots.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    if os.path.isdir(STATIC):
        for name in os.listdir(STATIC):
            src = os.path.join(STATIC, name)
            if os.path.isfile(src):
                shutil.copy(src, os.path.join(out, name))
    open(os.path.join(out, ".nojekyll"), "w").close()
    kb = lambda p: os.path.getsize(os.path.join(out, p)) / 1e3  # noqa: E731
    print(f"index.html {kb('index.html'):.0f} KB, data/spots.json {kb('data/spots.json'):.0f} KB", file=sys.stderr)


if __name__ == "__main__":
    build(*sys.argv[1:2])
