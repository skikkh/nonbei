"""Read the map pin of each spot's Tabelog page (English edition) for cross-checking.

Only the latitude/longitude on the shop page is used. Results are cached in
data/geocode_cache.json under "tabelog:<shop id>"; requests are spaced 1.5 s apart.
usage: python3 scripts/tabelog_coords.py
"""
import json
import os
import re
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
import build_spots as B  # noqa: E402

UA = "Mozilla/5.0 (compatible; nonbei-map/1.0; +https://github.com/skikkh/nonbei)"


def shop_url(sources):
    for u in sources or []:
        m = re.search(r"tabelog\.com/(?:en/)?(tokyo/A\d+/A\d+/(\d{8}))", u)
        if m:
            return "https://tabelog.com/en/" + m.group(1) + "/", m.group(2)
    return None, None


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en,ja;q=0.5"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def main():
    spots = json.load(open(os.path.join(B.ROOT, "data", "spots.json"), encoding="utf-8"))["spots"]
    n = 0
    for s in spots:
        url, sid = shop_url(s.get("sources"))
        if not url or f"tabelog:{sid}" in B.CACHE:
            continue
        try:
            page = fetch(url)
            la = re.search(r'latitude"\s*:\s*([0-9.]+)', page)
            lo = re.search(r'longitude"\s*:\s*([0-9.]+)', page)
            B.CACHE[f"tabelog:{sid}"] = [float(la.group(1)), float(lo.group(1))] if la and lo else None
        except Exception as e:
            print("tabelog failed", s["id"], e, file=sys.stderr)
            B.CACHE[f"tabelog:{sid}"] = None
        n += 1
        if n % 20 == 0:
            B.save_cache()
            print(n, file=sys.stderr)
        time.sleep(1.5)
    B.save_cache()
    print(f"fetched {n} pages", file=sys.stderr)


if __name__ == "__main__":
    main()
