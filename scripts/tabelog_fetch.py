"""Download the English Tabelog page of every spot that cites one (raw HTML cache).

Pages land in .cache/tabelog/<shop id>.html; requests are spaced 1.5 s apart.
usage: python3 scripts/tabelog_fetch.py [extra_urls.json]
"""
import json
import os
import re
import sys
import time
import urllib.request

ROOT = os.path.join(os.path.dirname(__file__), "..")
OUT = os.path.join(ROOT, ".cache", "tabelog")
UA = "Mozilla/5.0 (compatible; nonbei-map/1.0; +https://github.com/skikkh/nonbei)"
SHOP = re.compile(r"tabelog\.com/(?:en/)?(tokyo/A\d+/A\d+/(\d{8}))")


def shop_urls(spots):
    for s in spots:
        for u in s.get("sources") or []:
            m = SHOP.search(u)
            if m:
                yield s["id"], "https://tabelog.com/en/" + m.group(1) + "/", m.group(2)
                break


def main():
    os.makedirs(OUT, exist_ok=True)
    spots = json.load(open(os.path.join(ROOT, "data", "spots.json"), encoding="utf-8"))["spots"]
    todo = list(shop_urls(spots))
    if len(sys.argv) > 1:  # {"spot-id": "https://tabelog.com/..."} found later
        for sid, u in json.load(open(sys.argv[1], encoding="utf-8")).items():
            m = SHOP.search(u)
            if m:
                todo.append((sid, "https://tabelog.com/en/" + m.group(1) + "/", m.group(2)))
    n = 0
    for sid, url, shop in todo:
        path = os.path.join(OUT, shop + ".html")
        if os.path.exists(path) and os.path.getsize(path) > 10000:
            continue
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en"})
            with urllib.request.urlopen(req, timeout=30) as r:
                open(path, "wb").write(r.read())
        except Exception as e:
            print("failed", sid, url, e, file=sys.stderr)
        n += 1
        time.sleep(1.5)
    print(f"fetched {n} of {len(todo)} pages", file=sys.stderr)


if __name__ == "__main__":
    main()
