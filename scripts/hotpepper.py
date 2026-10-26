"""Shop facts from Hotpepper Gourmet for spots without a Tabelog page.

Searches Hotpepper by shop name, keeps a result only when its address matches
the spot's address (same ward and block numbers), and parses the store page
into the same fields as scripts/tabelog_parse.py. Pages are cached in
.cache/hotpepper/; requests are spaced 1.5 s apart. Writes data/hotpepper.json.
usage: python3 scripts/hotpepper.py
"""
import html
import json
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
from build_spots import name_cores, place_words, clean as clean_spot  # noqa: E402,F401
from tabelog_parse import JP_DAY, ORDER, hours_text  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), "..")
CACHE = os.path.join(ROOT, ".cache", "hotpepper")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
JDAYS = {"月": "mon", "火": "tue", "水": "wed", "木": "thu", "金": "fri", "土": "sat", "日": "sun", "祝日": "hol", "祝前日": "prehol", "祝後日": "posthol"}


def get(url, key):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, key + ".html")
    if os.path.exists(path):
        return open(path, encoding="utf-8", errors="replace").read()
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ja"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read()
    open(path, "wb").write(data)
    time.sleep(1.5)
    return data.decode("utf-8", "replace")


def clean(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()


def addr_key(a):
    """('北区', '上十条', '2-30-13') style key for comparing addresses."""
    a = unicodedata.normalize("NFKC", a or "")
    a = a.replace("丁目", "-").replace("番地", "-").replace("番", "-").replace("号", "").replace("−", "-").replace("ー", "-")
    m = re.search(r"([^都道府県]+?[区市町村])(.+?)(\d+(?:-\d+){0,2})", a)
    if not m:
        return None
    return m.group(1)[-4:], re.sub(r"\s", "", m.group(2))[-6:], m.group(3)


def same_place(a, b):
    ka, kb = addr_key(a), addr_key(b)
    if not ka or not kb or ka[0] != kb[0] or ka[1] != kb[1]:
        return False
    pa, pb = ka[2].split("-"), kb[2].split("-")
    n = min(len(pa), len(pb), 2)
    return pa[:n] == pb[:n]


def parse_hp_hours(t):
    week = {}
    for m in re.finditer(r"((?:(?:月|火|水|木|金|土|日|祝日|祝前日|祝後日)・?)+)\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})(?:\s*L\.O\.\s*(\d{1,2}:\d{2}))?", t):
        days = [JDAYS[d] for d in re.findall(r"祝前日|祝後日|祝日|月|火|水|木|金|土|日", m.group(1))]
        o = int(m.group(2)[:-3]) * 60 + int(m.group(2)[-2:])
        c = int(m.group(3)[:-3]) * 60 + int(m.group(3)[-2:])
        if c <= o:
            c += 24 * 60
        lo = None
        if m.group(4):
            lo = int(m.group(4)[:-3]) * 60 + int(m.group(4)[-2:])
            if lo < o:
                lo += 24 * 60
        for d in days:
            week.setdefault(d, []).append([o, c, lo])
    return week


WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
DAY = r"(?:祝前日|祝後日|祝日|[月火水木金土日])"
SEG = re.compile(rf"((?:{DAY}(?:\s*[~〜～]\s*{DAY})?\s*[、・,]?\s*)+)?[:：]?\s*(翌)?(\d{{1,2}}):(\d{{2}})\s*[~〜～]\s*(翌)?(\d{{1,2}}):(\d{{2}})"
                 r"(?:\s*[(（][^)）]*?L\.O\.\s*(翌)?(\d{1,2}):(\d{2})[^)）]*[)）])?")


def hp_days(spec):
    out = []
    for a, b in re.findall(rf"({DAY})(?:\s*[~〜～]\s*({DAY}))?", spec):
        if b and a in "月火水木金土日" and b in "月火水木金土日":
            i, j = "月火水木金土日".index(a), "月火水木金土日".index(b)
            out += [WEEK[k % 7] for k in range(i, (j if j >= i else j + 7) + 1)]
        else:
            out += [JDAYS[a]] + ([JDAYS[b]] if b else [])
    return out


def parse_hp_hours_v2(t, closed=""):
    """The current Hotpepper format: 「火～金: 16:30～22:30 （料理L.O. 22:00） 土: 12:00～翌0:00」, or a bare 「16:00～23:00」."""
    t = t.split("【")[0]
    week, shut = {}, []
    if not re.search(r"なし|^[－-]$|不定休", closed or ""):
        shut = hp_days(re.sub(r"曜日?", "", (closed or "").split("※")[0]))
    for m in SEG.finditer(t):
        o = int(m.group(3)) * 60 + int(m.group(4)) + (1440 if m.group(2) else 0)
        c = int(m.group(6)) * 60 + int(m.group(7)) + (1440 if m.group(5) else 0)
        if c <= o:
            c += 1440
        lo = None
        if m.group(9):
            lo = int(m.group(9)) * 60 + int(m.group(10)) + (1440 if m.group(8) else 0)
            if lo < o:
                lo += 1440
        days = hp_days(m.group(1)) if m.group(1) else [d for d in WEEK + ["hol"] if d not in shut]
        for d in days:
            week.setdefault(d, []).append([o, c, lo])
    if week:
        for d in shut:
            week.setdefault(d, [])
    return week


def parse_store(p):
    rows = {clean(a): clean(b) for a, b in re.findall(r"<th[^>]*>(.*?)</th>\s*<td[^>]*>(.*?)</td>", p, re.S)}
    out = {"address": rows.get("住所")}
    hrs = rows.get("営業時間", "")
    cl = rows.get("定休日", "")
    week = parse_hp_hours(hrs) or parse_hp_hours_v2(hrs, cl)
    if week and sum(c - o for rs in week.values() for o, c, _ in rs) < 120:
        week, out["dormant"] = {}, True  # 「日: 00:00～00:30」 and the rest closed: a page left up while the shop is shut
    if week:
        for d in re.findall(r"祝前日|祝後日|祝日|月|火|水|木|金|土|日", cl.split("※")[0]):
            if JDAYS[d] not in week:
                week[JDAYS[d]] = []
        out["week"] = week
        out["hours"] = hours_text(week)
    if cl:
        out["closed"] = cl
    b = rows.get("予算詳細") or rows.get("平均予算") or ""
    m = re.search(r"\[夜\]\s*￥?([\d,]+)\s*[～~]\s*￥?([\d,]+)", b)
    if m:
        out["budget_dinner"] = f"¥{m.group(1)}〜¥{m.group(2)}"
    m = re.search(r"\[昼\]\s*￥?([\d,]+)\s*[～~]\s*￥?([\d,]+)", b)
    if m:
        out["budget_lunch"] = f"¥{m.group(1)}〜¥{m.group(2)}"
    pay = rows.get("クレジットカード", "") + " " + rows.get("電子マネー", "") + " " + rows.get("QRコード決済", "")
    if pay.strip():
        parts = []
        if re.search(r"カード可|利用可", pay) and "カード不可" not in pay:
            parts.append("カード")
        if "電子マネー可" in pay:
            parts.append("電子マネー")
        if re.search(r"QRコード決済可", pay):
            parts.append("QR決済")
        out["pay"] = "現金・" + "・".join(parts) + "可" if parts else "現金のみ"
        out["cash_only"] = not parts
    seats = rows.get("総席数", "")
    m = re.match(r"(\d+)席", seats)
    if m:
        out["seats"] = int(m.group(1))
        note = re.search(r"（(.*?)）", seats)
        if note:
            out["seats_note"] = note.group(1)
    sm = rows.get("禁煙・喫煙", "")
    if sm:
        out["smoking"] = "全席禁煙" if "全面禁煙" in sm or "全席禁煙" in sm else "喫煙可" if "喫煙可" in sm else "分煙・喫煙所あり" if "分煙" in sm or "喫煙専用" in sm else None
    ch = rows.get("お通し", "") or rows.get("チャージ", "")
    if ch and ch not in ("－", "-"):
        out["charge"] = ch
    return {k: v for k, v in out.items() if v not in (None, "", [])}


def main():
    spots = json.load(open(os.path.join(ROOT, "data", "spots.json"), encoding="utf-8"))["spots"]
    have = json.load(open(os.path.join(ROOT, "data", "tabelog.json"), encoding="utf-8"))
    res, tried = {}, 0
    for s in spots:
        if s["kind"] == "yokocho" or s["status"] == "closed" or (s["id"] in have and have[s["id"]].get("week")):
            continue
        direct = next((m.group(1) for u in s.get("sources") or [] for m in [re.search(r"hotpepper\.jp/(strJ\d+)", u)] if m), None)
        if direct:  # the research already names the store page
            try:
                info = parse_store(get(f"https://www.hotpepper.jp/{direct}/", direct))
                info["url"] = f"https://www.hotpepper.jp/{direct}/"
                res[s["id"]] = info
            except Exception as e:
                print("store failed", direct, e, file=sys.stderr)
            continue
        cores = name_cores(s["name"], place_words(s), [s.get("en")])
        if not cores or not s.get("address"):
            continue
        tried += 1
        found = None
        for q in cores[:2]:
            try:
                page = get("https://www.hotpepper.jp/CSP/psh010/doBasic?SA=SA11&FWT=" + urllib.parse.quote(q),
                           "q_" + re.sub(r"\W", "_", q)[:60])
            except Exception as e:
                print("search failed", s["id"], e, file=sys.stderr)
                continue
            ids = []
            for m in re.finditer(r'<a href="/(strJ\d+)/"[^>]*>(.*?)</a>', page, re.S):
                if clean(m.group(2)) and m.group(1) not in ids:
                    ids.append(m.group(1))
            for sid in ids[:4]:
                try:
                    sp = get(f"https://www.hotpepper.jp/{sid}/", sid)
                except Exception as e:
                    print("store failed", sid, e, file=sys.stderr)
                    continue
                info = parse_store(sp)
                if info.get("address") and same_place(info["address"], s["address"]):
                    info["url"] = f"https://www.hotpepper.jp/{sid}/"
                    found = info
                    break
            if found:
                break
        if found:
            res[s["id"]] = found
    json.dump(res, open(os.path.join(ROOT, "data", "hotpepper.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"tried {tried}, matched {len(res)}", file=sys.stderr)


if __name__ == "__main__":
    main()
