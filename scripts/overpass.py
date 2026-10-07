"""Small Overpass API client with on-disk caching and mirror fallback."""
import hashlib
import json
import os
import sys
import time
import urllib.parse
import urllib.request

MIRRORS = [
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]
UA = "nonbei-map/1.0 (Tokyo nomiya map; contact via github.com/skikkh/nonbei)"
CACHE = os.environ.get("NONBEI_CACHE", os.path.join(os.path.dirname(__file__), "..", ".cache", "osm"))


def query(ql, name=None, timeout=300):
    os.makedirs(CACHE, exist_ok=True)
    key = name or hashlib.sha1(ql.encode()).hexdigest()[:16]
    path = os.path.join(CACHE, key + ".json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    body = urllib.parse.urlencode({"data": ql}).encode()
    last = None
    for attempt in range(3):
        for url in MIRRORS:
            try:
                req = urllib.request.Request(url, data=body, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    raw = r.read()
                data = json.loads(raw)
                if "remark" in data and "error" in data["remark"].lower():
                    raise RuntimeError(data["remark"])
                with open(path, "wb") as f:
                    f.write(raw)
                print(f"[overpass] {key}: {len(data.get('elements', []))} elements ({len(raw)/1e6:.1f} MB) via {url.split('/')[2]}", file=sys.stderr)
                return data
            except Exception as e:  # try next mirror
                last = e
                print(f"[overpass] {key}: {url.split('/')[2]} failed: {e}", file=sys.stderr)
        time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"overpass query {key} failed: {last}")
