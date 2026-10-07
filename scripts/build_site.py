"""Assemble the single-page app.

dist/artifact/  page fragment for claude.ai Artifacts (no remote tiles, no geolocation)
dist/pages/     full HTML document for any static host such as GitHub Pages
Both get data/base.json and data/c/*.json next to index.html.
"""
import json
import os
import shutil
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
SRC = os.path.join(ROOT, "site", "src")
DATA = os.path.join(ROOT, "site", "data")
VENDOR = os.path.join(ROOT, "site", "vendor")


def read(*p):
    with open(os.path.join(*p), encoding="utf-8") as f:
        return f.read()


def leaflet_css():
    css = read(VENDOR, "leaflet.css")
    # drop rules that point at Leaflet's bundled images; the page draws its own icons
    import re
    return re.sub(r"url\(images/[^)]*\)", "none", css)


def build(spots_path, out_root=os.path.join(ROOT, "dist")):
    spots = json.loads(read(spots_path))
    chunks = json.loads(read(DATA, "chunks.json"))
    payload = {
        "spots": spots["spots"],
        "regions": spots.get("regions", []),
        "updated": spots.get("updated"),
        "chunks": chunks,
    }
    data_js = "window.NB_DATA=" + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";"
    page = read(SRC, "page.html")
    page = (page.replace("/*LEAFLET_CSS*/", leaflet_css())
                .replace("/*APP_CSS*/", read(SRC, "style.css"))
                .replace("/*MAP_JS*/", read(SRC, "map.js"))
                .replace("/*APP_JS*/", read(SRC, "app.js")))
    targets = {
        "artifact": {"raster": False, "geo": False},
        "pages": {"raster": True, "geo": True},
    }
    for name, cfg in targets.items():
        out = os.path.join(out_root, name)
        if os.path.isdir(os.path.join(out, "data")):
            shutil.rmtree(os.path.join(out, "data"))
        os.makedirs(out, exist_ok=True)
        cfg_js = "window.NB_CONFIG=" + json.dumps({"dataUrl": "data/", **cfg}) + ";"
        html = page.replace("/*DATA_JS*/", cfg_js + data_js)
        if name == "pages":
            head, body = html.split('<div id="app">', 1)
            html = ('<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n'
                    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
                    + head + '</head>\n<body>\n<div id="app">' + body + "</body>\n</html>\n")
        with open(os.path.join(out, "index.html"), "w", encoding="utf-8") as f:
            f.write(html)
        shutil.copytree(DATA, os.path.join(out, "data"), ignore=shutil.ignore_patterns("chunks.json"))
        size = os.path.getsize(os.path.join(out, "index.html"))
        print(f"{name}: index.html {size/1e3:.0f} KB", file=sys.stderr)


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "data", "spots.json"))
