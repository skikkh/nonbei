"""Collect the review/article summaries into data/enrich.json.

Each summary round writes {spot id: {...}} files (fields: catch, crowd, busy,
rules, vibe, menu, charge, first, talk2, web, insta, x, fix, status, checked,
sources_add). Later files win per spot. Values are checked for type and
trimmed; unknown spot ids are dropped.
usage: python3 scripts/merge_enrich.py DIR [DIR ...]
"""
import glob
import json
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
TEXT = ("catch", "crowd", "busy", "vibe", "charge", "first", "talk2", "checked")
URLS = ("web", "insta", "x")


def clean_text(v, limit=400):
    if not isinstance(v, str):
        return None
    v = re.sub(r"\s+", " ", v).strip()
    return v[:limit] if v and v.lower() not in ("null", "none", "不明") else None


def clean(rec):
    out = {}
    for k in TEXT:
        v = clean_text(rec.get(k), 60 if k == "catch" else 400)
        if v:
            out[k] = v
    rules = [clean_text(r, 80) for r in rec.get("rules") or [] if isinstance(r, str)]
    if any(rules):
        out["rules"] = [r for r in rules if r][:8]
    menu = []
    for m in rec.get("menu") or []:
        if isinstance(m, dict) and clean_text(m.get("n"), 60):
            menu.append({"n": clean_text(m["n"], 60), "p": clean_text(m.get("p"), 40)})
    if menu:
        out["menu"] = menu[:6]
    for k in URLS:
        v = rec.get(k)
        if isinstance(v, str) and re.match(r"https?://\S+$", v.strip()):
            out[k] = v.strip()
    if isinstance(rec.get("fix"), dict):
        fx = {k: clean_text(v, 400) for k, v in rec["fix"].items() if clean_text(v, 400)}
        if fx:
            out["fix"] = fx
    if rec.get("status") in ("open", "closed", "uncertain"):
        out["status"] = rec["status"]
    srcs = [u.strip() for u in rec.get("sources_add") or [] if isinstance(u, str) and re.match(r"https?://\S+$", u.strip())]
    if srcs:
        out["sources_add"] = srcs[:4]
    return out


def main(dirs):
    ids = {s["id"] for s in json.load(open(os.path.join(ROOT, "data", "spots.json"), encoding="utf-8"))["spots"]}
    path = os.path.join(ROOT, "data", "enrich.json")
    merged = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}
    n = 0
    for d in dirs:
        for f in sorted(glob.glob(os.path.join(d, "*.json"))):
            for sid, rec in json.load(open(f, encoding="utf-8")).items():
                if sid in ids and isinstance(rec, dict):
                    c = clean(rec)
                    if c:
                        merged[sid] = c
                        n += 1
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(dict(sorted(merged.items())), fh, ensure_ascii=False, indent=1)
    print(f"merged {n} records, {len(merged)} spots in data/enrich.json", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1:])
