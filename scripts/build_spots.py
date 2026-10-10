"""Merge researched spots, geocode them and write data/spots.json.

Position of each spot, best first:
  osm       an OpenStreetMap shop/building whose name matches, near the address
  osm-area  for yokocho: the OSM area or street carrying the alley's name
  gsi       the address resolved to 号/番 by the GSI geocoder (国土地理院)
  approx    only 丁目-level; flagged for review
Every lookup is cached in data/geocode_cache.json so builds are reproducible.
"""
import glob
import hashlib
import json
import math
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
from geo import W, enc_str, proj, unproj  # noqa: E402
from overpass import CACHE as OSM_CACHE, query  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), "..")
CACHE_PATH = os.path.join(ROOT, "data", "geocode_cache.json")
UA = "nonbei-map/1.0 (github.com/skikkh/nonbei)"
KINDS = ["yokocho", "senbero", "tachinomi", "kakuuchi", "bar", "social"]
REGIONS = [  # research file stem -> region, in display order
    ("toshin", "都心（新橋・銀座・神田）"),
    ("ueno-asakusa", "上野・浅草・日暮里"),
    ("shinjuku-chuo", "新宿・中野・杉並"),
    ("shibuya-jonan", "渋谷・目黒・世田谷"),
    ("shinagawa-ota", "品川・大田"),
    ("akabane-ikebukuro", "池袋・赤羽・城北"),
    ("kitasenju-katsushika", "北千住・葛飾"),
    ("joto", "墨田・江東・江戸川"),
    ("tama", "多摩"),
]
AREA_ALIASES = {"新宿三丁目": "新宿", "新宿二丁目": "新宿", "新大久保・大久保": "新大久保", "府中本町": "府中",
                "西八王子": "八王子", "西国分寺": "国分寺", "東小金井": "小金井", "豊田": "日野",
                "沢井（青梅）": "青梅", "阿佐ヶ谷（南阿佐ケ谷）": "阿佐ヶ谷"}
STATUS = {"open", "closed", "uncertain"}

try:
    CACHE = json.load(open(CACHE_PATH, encoding="utf-8"))
except FileNotFoundError:
    CACHE = {}
try:  # traced yokocho outlines, see scripts/outline.py
    OUTLINES = json.load(open(os.path.join(ROOT, "data", "outline_shapes.json"), encoding="utf-8"))
except FileNotFoundError:
    OUTLINES = {}


def save_cache():
    with open(CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(CACHE, f, ensure_ascii=False, indent=0, sort_keys=True)


def nfkc(s):
    return unicodedata.normalize("NFKC", s or "")


def norm_name(s):
    s = nfkc(s).lower()
    s = re.sub(r"[\s・･\-‐ー−~〜'\"’”“「」『』()（）【】\[\]!！?？.,、。&＆]", "", s)
    s = re.sub(r"[ァ-ヶ]", lambda m: chr(ord(m.group()) - 0x60), s)
    return s


GENERIC = ["立ち飲み", "立飲み", "立呑み", "立ち呑み", "立ち呑", "立呑", "立飲", "立ち飲", "大衆酒場", "大衆居酒屋", "酒場", "居酒屋", "もつ焼き", "もつ焼", "やきとん",
           "焼きとん", "やきとり", "焼き鳥", "焼鳥", "串カツ", "串かつ", "おでん", "ホルモン", "角打ち", "酒店", "酒舗", "bar", "バー"]


def raw_core(s):
    return re.sub(r"[\s・･'\"’”“「」『』()（）【】\[\]!！?？.,、。]", "", nfkc(s))


SUFFIXES = ["総本店", "本店", "支店", "別館", "新館", "本館"]


ASCII_STOP = {"tachinomi", "tachinomiya", "sakaba", "yakiton", "yakitori", "motsuyaki", "kakuuchi", "saketen", "honten",
              "shoten", "guesthouse", "beerhall", "standbar", "nihonbashi", "shimbashi", "shinbashi", "hamacho",
              "tokyo", "japan", "bar", "pub", "cafe", "the", "snack", "stand", "house", "shop", "tavern", "izakaya",
              "kitchen", "dining", "hostel", "hotel", "lounge", "new", "beer", "wine", "sake", "club", "room", "inn",
              "land", "and", "of", "in", "no", "de", "le", "la", "music", "art", "shinjuku", "shibuya", "ginza", "asakusa",
              "ueno", "ikebukuro", "akabane", "grill", "food", "drink", "drinks", "craft", "tap", "taproom", "store"}


def _variants(src):
    toks = [raw_core(t) for t in re.split(r"\s+", src) if raw_core(t)]
    if not toks:
        return []
    out = [raw_core(src)]
    # a trailing token like "武蔵小山店" is a branch name
    main = [t for i, t in enumerate(toks)
            if not (i > 0 and t.endswith("店") and not t.endswith(("酒店", "商店", "飯店", "茶店", "本店")))]
    out.append("".join(main))
    for t in main:
        for suf in SUFFIXES:
            if t.endswith(suf) and len(t) - len(suf) >= 2:
                t = t[: -len(suf)]
        out.append(t)
    stripped = "".join(main)
    for g in GENERIC:
        stripped = re.sub(re.escape(g), "", stripped, flags=re.I)
    out.append(stripped)
    return out


def _romaji_places():
    """Romanised station names (from OSM name:en) — "HAMAMATSUCHO" in a shop name is a branch, not the shop."""
    out = set()
    try:
        els = json.load(open(os.path.join(OSM_CACHE, "stations.json"), encoding="utf-8"))["elements"]
    except (OSError, ValueError):
        return out
    for e in els:
        for k in ("name:en", "name:ja-Latn", "name:ja_rm"):
            v = (e.get("tags") or {}).get(k)
            if not v:
                continue
            v = unicodedata.normalize("NFKD", v).encode("ascii", "ignore").decode().lower()
            v = re.sub(r"\b(station|eki)\b", "", v)
            v = re.sub(r"[^a-z0-9]", "", v)
            if len(v) >= 4:
                out.add(v)
    return out


ROMAJI_PLACES = _romaji_places()


def name_cores(name, exclude=(), extra=()):
    """Distinctive parts of a shop name, original script, most telling first.

    `exclude` holds place names (the spot's town, ward) that must not count as a match;
    `extra` holds other names for the same place (the English name), used whole.
    """
    n = nfkc(name)
    alts = re.findall(r"[（(](.*?)[)）]", n)
    n = re.sub(r"[（(].*?[)）]", " ", n).strip()
    primary = _variants(n)
    full = raw_core(n)
    if full.endswith("横丁") and len(full) > 4:
        primary.append(full[:-2])
    for e in sorted((e for e in exclude if e), key=len, reverse=True):
        if full.startswith(e) and len(full) - len(e) >= 3:
            primary.append(full[len(e):])  # 渋谷のんべい横丁 -> のんべい横丁
            break
    secondary = [v for a in alts for v in _variants(a)] + [raw_core(nfkc(e)) for e in extra if e]
    generic = {norm_name(g) for g in GENERIC + SUFFIXES + ["店", "横丁", "通り", "新宿", "東京"] + [e for e in exclude if e]}
    wholes = {norm_name(full)} | {norm_name(raw_core(a)) for a in alts} | {norm_name(raw_core(nfkc(e))) for e in extra if e}
    out, seen = [], set()
    for gi, group in enumerate((sorted(primary, key=len, reverse=True), sorted(secondary, key=len, reverse=True))):
        for c in group:
            k = norm_name(c)
            if len(k) < 2 or k in seen or k in generic:
                continue
            whole = k in wholes or gi == 0
            if re.fullmatch(r"[a-z0-9&]+", k) and (k in ASCII_STOP or k in ROMAJI_PLACES or len(k) < (4 if whole else 6)):
                continue  # short or common English words match too many places
            seen.add(k)
            out.append(c)
    return out


def loose(core):
    """Overpass regex for a core that tolerates spaces and dots between characters."""
    return "[ 　・･.]*".join(re.escape(ch) for ch in core)


def canon_area(a):
    al = {nfkc(k): v for k, v in AREA_ALIASES.items()}
    a = nfkc(a or "").strip()
    a = al.get(a, a)
    a = re.sub(r"\(.*?\)", "", a).strip()
    return al.get(a, a)


def meters(a, b):
    """Distance in metres between (lat, lon) pairs."""
    la1, lo1 = map(math.radians, a)
    la2, lo2 = map(math.radians, b)
    x = (lo2 - lo1) * math.cos((la1 + la2) / 2)
    return math.hypot(x, la2 - la1) * 6371008.8


# ---------------------------------------------------------------- GSI geocoder

def clean_address(a):
    a = nfkc(a).replace("−", "-").replace("ー", "-").replace("―", "-").replace("‐", "-")
    a = re.sub(r"\s+", "", a)
    a = re.sub(r"^〒?\d{3}-?\d{4}", "", a)
    m = re.match(r"^(.*?\d+(?:丁目)?(?:[-の]\d+){0,3}(?:番地?)?(?:\d+号?)?)", a)
    return m.group(1) if m else a


def gsi(address):
    a = clean_address(address)
    key = "gsi:" + a
    if key not in CACHE:
        url = "https://msearch.gsi.go.jp/address-search/AddressSearch?q=" + urllib.parse.quote(a)
        for attempt in range(3):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30) as r:
                    res = json.loads(r.read())
                break
            except Exception as e:  # retry transient failures
                print("gsi retry", a, e, file=sys.stderr)
                time.sleep(2 * (attempt + 1))
        else:
            res = []
        CACHE[key] = res[0] if res else None
        time.sleep(0.25)
    hit = CACHE[key]
    if not hit:
        return None
    lon, lat = hit["geometry"]["coordinates"]
    title = hit["properties"]["title"]
    level = "号" if "号" in title else "番" if "番" in title else "丁目" if "丁目" in title else "町"
    return {"lat": lat, "lng": lon, "title": title, "level": level, "query": a}


# ---------------------------------------------------------------- OSM lookup

def overpass_named(cores, lat, lon, radius=450):
    pattern = "|".join(loose(c) for c in cores[:5])
    key = f"ovp:{pattern}@{lat:.4f},{lon:.4f},{radius}"
    if key not in CACHE:
        pat = pattern.replace("\\", "\\\\").replace('"', '\\"')
        ql = (f'[out:json][timeout:60];(nwr["name"~"{pat}",i](around:{radius},{lat:.6f},{lon:.6f});'
              f'nwr["name:ja"~"{pat}",i](around:{radius},{lat:.6f},{lon:.6f}););out geom;')
        try:
            els = query(ql, name="q_" + hashlib.sha1(key.encode()).hexdigest()[:16])["elements"]
        except Exception as e:
            print("overpass failed", cores, e, file=sys.stderr)
            return []
        keep = []
        for e in els:
            t = e.get("tags", {})
            if e["type"] == "node":
                c = (e["lat"], e["lon"])
            elif e.get("bounds"):
                b = e["bounds"]
                c = ((b["minlat"] + b["maxlat"]) / 2, (b["minlon"] + b["maxlon"]) / 2)
            else:
                continue
            item = {"type": e["type"], "id": e["id"], "lat": c[0], "lng": c[1], "name": t.get("name", ""),
                    "tags": {k: v for k, v in t.items() if k in ("amenity", "shop", "highway", "landuse", "place", "building", "name:en", "tourism", "leisure")}}
            if e["type"] == "way" and e.get("geometry"):
                item["geom"] = [[p["lat"], p["lon"]] for p in e["geometry"] if p]
            if e["type"] == "relation":
                item["members"] = [[[p["lat"], p["lon"]] for p in (m.get("geometry") or []) if p]
                                   for m in e.get("members", []) if m.get("type") == "way" and m.get("role") in ("outer", "")]
            keep.append(item)
        CACHE[key] = keep
    return CACHE[key]


DRINK_AMENITY = {"bar", "pub", "restaurant", "izakaya", "biergarten", "cafe", "fast_food", "nightclub", "food_court", "karaoke_box"}
DRINK_SHOP = {"alcohol", "wine", "beverages", "butcher", "seafood", "deli", "convenience", "general", "confectionery"}
STAY = {"hostel", "guest_house", "hotel", "motel"}


def place_words(spot):
    w = [spot.get("area"), spot.get("area_label"), spot.get("ward")]
    w += re.findall(r"[一-龯ぁ-んァ-ヶ]{2,}(?=駅)", spot.get("station") or "")
    m = re.match(r"東京都(.+?[区市町村])(.+?)[0-9０-９]", nfkc(spot.get("address") or ""))
    if m:
        town = re.sub(r"[一二三四五六七八九十]+丁目$", "", m.group(2))
        w += [m.group(1), town]
    return [x for x in w if x]


def best_osm(spot, near):
    cores = name_cores(spot["name"], place_words(spot), [spot.get("en")])
    if not cores:
        return None
    cands = overpass_named(cores, near["lat"], near["lng"], 450 if spot["kind"] != "yokocho" else 800)
    best = None
    for c in cands:
        nn = norm_name(c["name"])
        if not nn:
            continue
        nc = [norm_name(k) for k in cores]
        hit = max((len(k) for k in nc if k in nn), default=0)
        if nn == nc[0]:
            score = 3  # the whole name
        elif hit or (len(nn) >= 3 and nn in nc[0]):
            score = 2
        else:
            continue
        t = c["tags"]
        if spot["kind"] != "yokocho" and not (t.get("amenity") in DRINK_AMENITY or t.get("shop") in DRINK_SHOP
                                              or t.get("tourism") in STAY):
            continue  # same name, but a clinic, a street or an office
        if spot["kind"] == "yokocho" and (t.get("highway") or t.get("landuse") or t.get("place") or c.get("geom") or c.get("members")):
            score += 1
        d = meters((near["lat"], near["lng"]), (c["lat"], c["lng"]))
        if score == 2 and hit and hit <= 3 and d > 80:
            continue  # a short shared word ("富士屋", "ばん") only counts right next to the address
        # with a building-level address, a name match right at the address beats a better name further away
        close = near.get("level") == "号" and d <= 40
        rank = (close, -d if close else 0, score, -d)
        if best is None or rank > best[0]:
            best = (rank, c, d)
    if best:
        best = ((best[0][2], best[0][3]), best[1], best[2])
    return best


def shape_of(spot, osm_hits, cores=()):
    """Outline (polygon) or centre line for a yokocho from OSM features with its name.

    Polygons count when they describe the place itself (a retail/market area, or a
    building named exactly like it, e.g. ニュー新橋ビル); streets give centre lines.
    Shops or office blocks that merely carry the name are ignored.
    """
    from shapely.geometry import LineString, Polygon
    from shapely.ops import polygonize, unary_union
    exact = {norm_name(c) for c in cores}
    polys, lines = [], []
    for c in osm_hits:
        t = c["tags"]
        areaish = t.get("landuse") or t.get("place") or t.get("amenity") == "marketplace" or t.get("leisure")
        named_itself = norm_name(c["name"]) in exact
        if c.get("members"):
            if areaish or named_itself:
                ls = [LineString([proj(lo, la) for la, lo in m]) for m in c["members"] if len(m) >= 2]
                polys += list(polygonize(unary_union(ls))) if ls else []
        elif c.get("geom") and len(c["geom"]) >= 2:
            g = [proj(lo, la) for la, lo in c["geom"]]
            if t.get("highway") and t.get("area") != "yes":
                lines.append(g)
            elif g[0] == g[-1] and len(g) >= 4 and (areaish or named_itself or t.get("area") == "yes"):
                polys.append(Polygon(g))
    if polys:
        u = unary_union([p.buffer(0) for p in polys])
        geoms = list(getattr(u, "geoms", [u]))
        return {"t": "poly", "p": [enc_str(p.exterior.coords, close=True)[0] for p in geoms if p.area > 20]}
    if lines:
        return {"t": "line", "p": [enc_str(l)[0] for l in lines]}
    return None


# ---------------------------------------------------------------- stations

def load_stations():
    base = json.load(open(os.path.join(ROOT, "site", "data", "base.json"), encoding="utf-8"))
    out = []
    for l in base["labels"]:
        if l[0] == "s":
            lon, lat = unproj(l[2], l[3])
            out.append((l[4], lat, lon))
    return out


def nearest_stations(st, lat, lng, k=2):
    ds = sorted(((meters((lat, lng), (s[1], s[2])), s[0]) for s in st))
    out, seen = [], set()
    for d, n in ds:
        if n in seen or d > 2500:
            continue
        seen.add(n)
        out.append([n, round(d)])
        if len(out) == k:
            break
    return out


# ---------------------------------------------------------------- merge

def clean(s):
    out = {}
    for k in ["id", "name", "name_kana", "name_en", "kind", "yokocho", "area", "ward", "address", "address_detail", "station",
              "hours", "closed", "budget", "budget_min", "budget_max", "price_note", "social", "solo", "hiru", "tags", "payment",
              "smoking", "english", "desc", "talk", "tips", "shops", "since", "status", "checked", "sources", "where", "members"]:
        v = s.get(k)
        if isinstance(v, str):
            v = v.strip() or None
        out[k] = v
    out["kana"] = out.pop("name_kana")
    out["en"] = out.pop("name_en")
    out["price"] = out.pop("price_note")
    if out["kind"] not in KINDS:
        out["kind"] = {"izakaya": "senbero", "standing": "tachinomi", "snack": "bar"}.get(out["kind"], "bar")
    for k in ("social", "solo"):
        try:
            out[k] = max(1, min(5, int(out[k])))
        except (TypeError, ValueError):
            out[k] = 3
    for k in ("budget_min", "budget_max", "shops"):
        try:
            out[k] = int(out[k]) if out[k] is not None else None
        except (TypeError, ValueError):
            out[k] = None
    out["hiru"] = bool(out["hiru"])
    out["english"] = bool(out["english"])
    out["tags"] = [t for t in (out["tags"] or []) if isinstance(t, str)][:12]
    out["sources"] = [u for u in (out["sources"] or []) if isinstance(u, str) and u.startswith("http")][:4]
    out["members"] = [m.strip() for m in (out["members"] or []) if isinstance(m, str) and m.strip()][:20]
    if out["status"] not in STATUS:
        out["status"] = "uncertain"
    out["id"] = re.sub(r"[^a-z0-9-]+", "-", (out["id"] or "").lower()).strip("-")
    return out


def link_members(spots):
    """A shop the research lists among a nearby yokocho's members belongs to that yokocho."""
    generic = {norm_name(g) for g in GENERIC} | ASCII_STOP

    def cores(name):
        return {c for c in (norm_name(v) for v in _variants(re.sub(r"[（(].*?[)）]", " ", name)))
                if len(c) >= 2 and c not in generic}

    yks = [(y, [cores(m) for m in y["members"]]) for y in spots if y["kind"] == "yokocho" and y.get("members")]
    n = 0
    for s in spots:
        if s["kind"] == "yokocho" or s.get("yokocho"):
            continue
        mine, best = cores(s["name"]), None
        for y, mem in yks:
            d = meters((s["lat"], s["lng"]), (y["lat"], y["lng"]))
            if d > 350 or (best and d >= best[0]):
                continue
            if any(a == b or (min(len(a), len(b)) >= 3 and (a in b or b in a)) for m in mem for a in mine for b in m):
                best = (d, y["id"])
        if best:
            s["yokocho"] = best[1]
            n += 1
    print(f"linked {n} shops to the yokocho that list them", file=sys.stderr)


def prefetch(spots, workers=3):
    """Warm the Overpass cache in parallel; the main loop then runs from cache."""
    from concurrent.futures import ThreadPoolExecutor
    jobs = []
    for s in spots:
        if s.get("lat") and s.get("lng"):
            g = {"lat": s["lat"], "lng": s["lng"]}
        elif s["address"]:
            g = gsi(s["address"])
        else:
            g = None
        if not g:
            continue
        cores = name_cores(s["name"], place_words(s), [s.get("en")])
        if cores:
            jobs.append((cores, g["lat"], g["lng"], 450 if s["kind"] != "yokocho" else 800))
    todo = [j for j in jobs if f"ovp:{'|'.join(loose(c) for c in j[0][:5])}@{j[1]:.4f},{j[2]:.4f},{j[3]}" not in CACHE]
    print(f"prefetch: {len(todo)} of {len(jobs)} lookups not cached", file=sys.stderr)
    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(lambda j: overpass_named(*j), todo))
    save_cache()


def main():
    files = sorted(glob.glob(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "research", "*.json")))
    # e.g. NONBEI_SKIP=sweep-g01,sweep-g02 leaves out research files still being written
    skip = tuple(p for p in os.environ.get("NONBEI_SKIP", "").split(",") if p)
    if skip:
        files = [f for f in files if not os.path.basename(f).startswith(skip)]
    overrides = {}
    opath = os.path.join(ROOT, "data", "overrides.json")
    if os.path.exists(opath):
        overrides = json.load(open(opath, encoding="utf-8"))
    spots, seen = [], {}
    for f in files:
        try:
            arr = json.load(open(f, encoding="utf-8"))
        except Exception as e:
            print("skip", f, e, file=sys.stderr)
            continue
        for raw in arr:
            s = clean(raw)
            s.update(overrides.get(s["id"], {}))
            if not s["name"] or not s["id"] or s.pop("exclude", None):
                continue
            key = norm_name(s["name"]) + "|" + norm_name(s["area"] or "")
            if s["id"] in seen or key in seen:
                print("dup", s["id"], s["name"], file=sys.stderr)
                continue
            seen[s["id"]] = seen[key] = True
            stem = os.path.splitext(os.path.basename(f))[0]
            s["region"] = dict(REGIONS).get(stem, "その他")
            if s["area"]:
                ca = canon_area(s["area"])
                if ca != nfkc(s["area"]).strip():
                    s["area_label"] = s["area"]
                s["area"] = ca
            spots.append(s)
    stations = load_stations()
    review = []
    prefetch(spots)
    for i, s in enumerate(spots):
        g = None
        if s.get("lat") and s.get("lng"):
            g = {"lat": s["lat"], "lng": s["lng"], "level": "manual", "title": None}
        elif s["address"]:
            g = gsi(s["address"])
        if g is None:
            review.append((s["id"], "no geocode", s["address"]))
            continue
        pos = {"lat": g["lat"], "lng": g["lng"], "geo": {"号": "gsi", "番": "gsi-block"}.get(g["level"], "approx")}
        if g["level"] == "manual":
            pos["geo"] = "manual"
        hit = best_osm(s, g) if pos["geo"] != "manual" else None
        if hit:
            (score, negd), c, d = hit
            limit = {"号": 150, "番": 300}.get(g["level"], 700)
            if s["kind"] == "yokocho":
                limit = 700
            if d <= limit:
                pos = {"lat": c["lat"], "lng": c["lng"], "geo": "osm-area" if s["kind"] == "yokocho" else "osm",
                       "osm": c["type"][0] + str(c["id"])}
                if d > 100 and s["kind"] != "yokocho":
                    review.append((s["id"], f"osm {d:.0f}m from address", c["name"]))
            else:
                review.append((s["id"], f"osm match too far {d:.0f}m", c["name"]))
        if s.get("shape_ways"):
            ids = ",".join(map(str, s["shape_ways"]))
            key = "ways:" + ids
            if key not in CACHE:
                els = query(f"[out:json][timeout:60];way(id:{ids});out geom;", name="w_" + hashlib.sha1(ids.encode()).hexdigest()[:12])["elements"]
                CACHE[key] = [[[p["lat"], p["lon"]] for p in e["geometry"]] for e in els]
            s["shape"] = {"t": "line", "p": [enc_str([proj(lo, la) for la, lo in g])[0] for g in CACHE[key]]}
        elif s["kind"] == "yokocho":
            cores = name_cores(s["name"], place_words(s), [s.get("en")])
            nc = [norm_name(k) for k in cores]
            hits = [c for c in overpass_named(cores, g["lat"], g["lng"], 800)
                    if any(k in norm_name(c["name"]) for k in nc) and meters((g["lat"], g["lng"]), (c["lat"], c["lng"])) < 800]
            sh = shape_of(s, hits, cores)
            if sh:
                s["shape"] = sh
        # cross-check with the shop's Tabelog map pin (see scripts/tabelog_coords.py)
        m = re.search(r"tabelog\.com/(?:en/)?tokyo/A\d+/A\d+/(\d{8})", " ".join(s.get("sources") or []))
        pin = CACHE.get(f"tabelog:{m.group(1)}") if m and s["kind"] != "yokocho" else None  # a yokocho cites one of its shops
        if pin:
            d = meters((pos["lat"], pos["lng"]), tuple(pin))
            if pos["geo"] in ("gsi-block", "approx") and d < 600:
                s["xcheck"] = round(d)  # how far the address-only guess was
                pos = {"lat": pin[0], "lng": pin[1], "geo": "tabelog"}
            else:
                s["xcheck"] = round(d)
                if d > 120:
                    review.append((s["id"], f"tabelog pin {d:.0f}m from our position", pos["geo"]))
        if pos["geo"] == "approx":
            review.append((s["id"], "address only to " + g["level"], g.get("title")))
        if s["id"] in OUTLINES:
            # a traced outline (scripts/outline.py) beats the shape found by name; keep the pin inside it
            from shapely.geometry import Point, Polygon
            from shapely.ops import unary_union
            o = OUTLINES[s["id"]]
            s["shape"] = {"t": "poly", "p": o["p"]}
            area = unary_union([Polygon([proj(lo, la) for la, lo in r]).buffer(0) for r in o["ll"]])
            gap = area.distance(Point(proj(pos["lng"], pos["lat"]))) * 40075016.686 * math.cos(math.radians(pos["lat"])) / W
            if gap > 8:
                pos = {"lat": o["c"][0], "lng": o["c"][1], "geo": "outline"}
        s.update(pos)
        s["gsi"] = g.get("title")
        s["near"] = nearest_stations(stations, s["lat"], s["lng"])
        if i % 20 == 0:
            save_cache()
            print(f"{i}/{len(spots)}", file=sys.stderr)
    save_cache()
    spots = [s for s in spots if "lat" in s]
    # spots from cross-area files take the region of the nearest spot that has one
    known = [s for s in spots if s["region"] != "その他"]
    for s in spots:
        if s["region"] == "その他" and known:
            near = min(known, key=lambda k: meters((s["lat"], s["lng"]), (k["lat"], k["lng"])))
            s["region"] = near["region"]
    ids = {s["id"] for s in spots}
    link_members(spots)
    for s in spots:
        if s["yokocho"] and s["yokocho"] not in ids:
            review.append((s["id"], "unknown parent yokocho", s["yokocho"]))
            s["yokocho"] = None
        s.pop("shape_ways", None)
        for k in [k for k, v in s.items() if v is None or v == [] or k.startswith("_")]:
            del s[k]
        s["lat"] = round(s["lat"], 7)
        s["lng"] = round(s["lng"], 7)
    # shops sharing one address point (common in Golden Gai) are fanned out a few metres apart
    stacks = {}
    for s in spots:
        if s["geo"] in ("gsi", "gsi-block", "approx"):
            stacks.setdefault((round(s["lat"], 6), round(s["lng"], 6)), []).append(s)
    for (la, lo), group in stacks.items():
        if len(group) < 2:
            continue
        r = 4.0 + len(group)  # metres
        for i, s in enumerate(sorted(group, key=lambda x: x["id"])):
            a = 2 * math.pi * i / len(group)
            s["lat"] = la + r * math.cos(a) / 111320
            s["lng"] = lo + r * math.sin(a) / (111320 * math.cos(math.radians(la)))
            s["stacked"] = len(group)
    region_order = [r for _, r in REGIONS] + ["その他"]
    regions = []
    for r in region_order:
        cnt = {}
        for s in spots:
            if s.get("region") == r and s.get("status") != "closed":
                cnt[s["area"]] = cnt.get(s["area"], 0) + 1
        if cnt:
            regions.append({"name": r, "areas": sorted(cnt, key=lambda a: (-cnt[a], a))})
    spots.sort(key=lambda s: (region_order.index(s.get("region", "その他")), s["area"], s["kind"] != "yokocho", s["id"]))
    xs = sorted(s["xcheck"] for s in spots if s.get("xcheck") is not None and s["geo"] != "tabelog")
    accuracy = {"n": len(xs), "median": xs[len(xs) // 2], "p90": xs[int(len(xs) * 0.9)]} if xs else None
    out = {"updated": "2026年10月", "accuracy": accuracy, "regions": regions, "spots": spots}
    with open(os.path.join(ROOT, "data", "spots.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    with open(os.path.join(ROOT, "data", "review.txt"), "w", encoding="utf-8") as f:
        for r in review:
            f.write("\t".join(map(str, r)) + "\n")
    print(f"spots={len(spots)} review={len(review)}", file=sys.stderr)


if __name__ == "__main__":
    main()
