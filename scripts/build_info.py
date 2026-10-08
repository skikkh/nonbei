"""Merge every source of shop facts into one record per spot.

inputs   data/spots.json       curated spots (research/*.json via build_spots.py)
         data/tabelog.json     facts parsed from Tabelog shop pages
         data/hotpepper.json   facts parsed from Hotpepper shop pages
         data/enrich.json      what reviews and articles say (客層・混む時間・ルール…)
output   data/info.json        {id: {field: value, ..., "src": {field: source}}}

Shop pages win for hours, payment, seats, smoking, charge and phone; the
research notes fill the gaps. Research hours written as free text
("月〜金 18:00〜22:00", closed "土・日・祝") are turned into the same weekly
structure as the shop pages so the map can tell what is open now.
usage: python3 scripts/build_info.py
"""
import json
import os
import re
import sys
import unicodedata

sys.path.insert(0, os.path.dirname(__file__))
from tabelog_parse import ORDER, hours_text  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), "..")
DATA = os.path.join(ROOT, "data")
WEEK = ORDER[:7]
JD = {"月": "mon", "火": "tue", "水": "wed", "木": "thu", "金": "fri", "土": "sat", "日": "sun"}


def load(name):
    p = os.path.join(DATA, name)
    return json.load(open(p, encoding="utf-8")) if os.path.exists(p) else {}


# ---------------------------------------------------------------- free-text hours
def days_in(spec):
    """'月〜金' / '土日祝' / '平日' / '金・土・祝前日' → day keys."""
    spec = unicodedata.normalize("NFKC", spec)
    out = []
    if "毎日" in spec or "全日" in spec:
        out += WEEK
    if "平日" in spec:
        out += WEEK[:5]
    if "祝前" in spec:
        out.append("prehol")
        spec = spec.replace("祝前日", "").replace("祝前", "")
    if "祝" in spec:
        out.append("hol")
    for a, b in re.findall(r"([月火水木金土日])[〜~\-ー]([月火水木金土日])", spec):
        i, j = WEEK.index(JD[a]), WEEK.index(JD[b])
        out += WEEK[i:j + 1] if i <= j else WEEK[i:] + WEEK[:j + 1]
        spec = spec.replace(a, " ", 1).replace(b, " ", 1)
    for ch in re.findall(r"[月火水木金土日]", spec.replace("毎日", "").replace("平日", "").replace("全日", "")):
        out.append(JD[ch])
    seen = []
    for d in out:
        if d not in seen:
            seen.append(d)
    return seen


def minutes(t, base=None):
    t = unicodedata.normalize("NFKC", t)
    nxt = "翌" in t
    if "始発" in t:
        return 29 * 60
    m = re.search(r"(\d{1,2})(?::|時)(\d{2})?", t)
    if not m:
        return None
    v = int(m.group(1)) * 60 + int(m.group(2) or 0)
    if nxt or (base is not None and v <= base):
        v += 24 * 60
    return v


TR = r"(翌?\d{1,2}(?::\d{2}|時(?:\d{2}分?)?)(?:頃|すぎ|過ぎ)?)\s*[〜~\-ー－]\s*(翌?\d{1,2}(?::\d{2}|時(?:\d{2}分?)?)|始発|翌朝)(?:頃)?(?:\s*[（(]?\s*L\.?O\.?\s*(翌?\d{1,2}:\d{2})\s*[）)]?)?"


def ranges_in(s):
    out = []
    for m in re.finditer(TR, s):
        o = minutes(m.group(1))
        c = minutes(m.group(2), o) if m.group(2) not in ("翌朝",) else 29 * 60
        if o is None or c is None:
            continue
        lo = minutes(m.group(3), o) if m.group(3) else None
        out.append([o, c, lo])
    return out


def split_top(s):
    """Split on ／ 、 , outside parentheses."""
    out, depth, cur = [], 0, ""
    for ch in s:
        if ch in "（(":
            depth += 1
        elif ch in "）)":
            depth = max(0, depth - 1)
        if depth == 0 and ch in "／/、,，":
            out.append(cur)
            cur = ""
        else:
            cur += ch
    out.append(cur)
    return [x for x in out if x.strip()]


DAYSPEC = r"((?:平日|毎日|祝前日|祝日|[月火水木金土日祝](?:曜日?)?|[・〜~\-ー]|\s)+?)"
DAYSPEC_G = r"((?:平日|毎日|祝前日|祝日|[月火水木金土日祝](?:曜日?)?|[・〜~\-ー]|\s)+)"


def parse_free_hours(hours, closed):
    """Week dict from research text, or None when it is not clear enough."""
    if not hours:
        return None
    h = unicodedata.normalize("NFKC", hours)
    if re.search(r"日により|日替わり|告知|カレンダー|不定|イベント|要確認|予約制|完売|なくなり次第|深夜", h):
        return None
    # drop notes about where the hours came from
    h = re.sub(r"[（(][^）)]*?(掲載|時点|記事|口コミ|資料|情報|記載|食べログ|公式)[^）)]*[）)]", "", h)
    h = re.sub(r"※[^／]*", "", h)
    week, last_days = {}, None
    plain = []
    for seg in split_top(h):
        body = re.sub(r"[（(](?!\s*L\.?O)[^）)]*[）)]", "", seg)
        m = re.match(r"\s*(?:ランチ|ディナー|昼|夜|ショップ|バー|店内|店頭|角打ち)?\s*[:：]?\s*" + DAYSPEC + r"\s*(?:は)?\s*(\d|翌)", body)
        rs = ranges_in(body)
        if not rs:
            continue
        if m and m.group(1).strip(" ・"):
            last_days = days_in(m.group(1))
            for d in last_days:
                week.setdefault(d, []).extend(r for r in rs if r not in week.get(d, []))
        elif last_days and not plain:
            # 「月〜土11:30〜14:00、16:00〜20:00」: a second range for the same days
            for d in last_days:
                week[d].extend(r for r in rs if r not in week[d])
        else:
            plain.append(rs)
        # exceptions in parentheses: 「（日祝〜22:00）」「（金・土は翌4:00まで）」「（土16:00〜18:00）」「（土・祝14:00〜）」
        for ex in re.finditer(r"[（(]([^）)]*)[）)]", seg):
            inner = ex.group(1)
            for part in re.split(r"[、,]", inner):
                dm = re.match(r"\s*" + DAYSPEC_G + r"\s*(?:は|のみ)?\s*(.*)$", part)
                if not dm or not dm.group(1).strip(" ・〜~"):
                    continue
                spec, rest = dm.group(1), dm.group(2)
                if spec.rstrip().endswith(("〜", "~")):
                    spec, rest = spec.rstrip()[:-1], "〜" + rest
                if not rest:
                    continue
                ds = days_in(spec)
                full = ranges_in(rest)
                until = re.match(r"[〜~]\s*(翌?\d{1,2}:\d{2})|(翌?\d{1,2}:\d{2})\s*(?:まで|閉店)", rest)
                since = re.match(r"(翌?\d{1,2}:\d{2})\s*[〜~]\s*$", rest)
                for d in ds:
                    if full:
                        week[d] = full
                    elif until or since:
                        base = week.get(d) or (plain[0] if plain else None) or (rs if not m else None)
                        if not base:
                            continue
                        o, c, lo = base[0]
                        if until:
                            c = minutes(until.group(1) or until.group(2), o)
                        else:
                            o = minutes(since.group(1))
                            c = c if c > o else c + 1440
                        week[d] = [[o, c, None]]
    if plain:
        for d in WEEK + ["hol"]:
            week.setdefault(d, list(plain[0]))
    if not week:
        return None
    if closed:
        c = unicodedata.normalize("NFKC", closed)
        c = re.sub(r"[（(].*?[）)]|元日|年末年始|お盆|夏季|冬季|正月|GW|ゴールデンウィーク", "", c)
        if not re.search(r"第\d|隔週|最終|不定", c):
            for d in days_in(c):
                week[d] = []
    return {d: week[d] for d in ORDER if d in week}


# ---------------------------------------------------------------- merge
def first(*pairs):
    for v, src in pairs:
        if v not in (None, "", [], {}) and not (isinstance(v, str) and re.fullmatch(r"\s*(不明|未確認|要確認|—|-|－)\s*", v)):
            return v, src
    return None, None


def old_note(text):
    """'（2019年時点）' style notes older than 2024 make free-text hours unreliable for 'open now'."""
    years = [int(y) for y in re.findall(r"(20\d\d)年", text or "")]
    return bool(years) and max(years) < 2024


def main():
    spots = load("spots.json")["spots"]
    tb, hp, en = load("tabelog.json"), load("hotpepper.json"), load("enrich.json")
    out = {}
    stats = {"week_tabelog": 0, "week_hotpepper": 0, "week_text": 0, "week_none": 0, "enriched": 0}
    for s in spots:
        sid = s["id"]
        t, h, e = tb.get(sid, {}), hp.get(sid, {}), en.get(sid, {})
        rec, src = {}, {}

        def put(key, *pairs):
            v, where = first(*pairs)
            if v is not None:
                rec[key] = v
                src[key] = where

        # hours
        if t.get("week"):
            rec["week"], rec["hours"], src["hours"] = t["week"], t.get("hours"), "食べログ"
            stats["week_tabelog"] += 1
        elif h.get("week"):
            rec["week"], rec["hours"], src["hours"] = h["week"], h.get("hours"), "ホットペッパー"
            stats["week_hotpepper"] += 1
        else:
            wk = None if s["kind"] == "yokocho" else parse_free_hours(s.get("hours"), s.get("closed"))
            if s.get("hours"):
                rec["hours"], src["hours"] = s["hours"], "調査"
            if wk and not old_note((s.get("hours") or "") + (s.get("closed") or "")):
                rec["week"] = wk
                rec["week_from_text"] = True
                stats["week_text"] += 1
            else:
                stats["week_none"] += 1
        put("closed", (h.get("closed"), "ホットペッパー"), (s.get("closed"), "調査"))
        if t.get("week") and s.get("closed"):
            rec["closed"], src["closed"] = s["closed"], "調査"
        if t.get("week") or h.get("week"):
            rec["hours_research"] = s.get("hours")

        put("pay", (t.get("pay"), "食べログ"), (h.get("pay"), "ホットペッパー"), (s.get("payment"), "調査"))
        cash = t.get("cash_only", h.get("cash_only"))
        if cash is None and s.get("payment"):
            cash = bool(re.search(r"現金のみ", s["payment"]))
        if cash is not None:
            rec["cash_only"] = cash
        put("seats", (t.get("seats"), "食べログ"), (h.get("seats"), "ホットペッパー"))
        put("seats_note", (t.get("seats_note"), "食べログ"), (h.get("seats_note"), "ホットペッパー"))
        put("seating", (t.get("seating"), "食べログ"))
        put("smoking", (t.get("smoking"), "食べログ"), (h.get("smoking"), "ホットペッパー"), (s.get("smoking"), "調査"))
        put("charge", (t.get("charge"), "食べログ"), (h.get("charge"), "ホットペッパー"), (e.get("charge"), "口コミ"))
        put("reserve", (t.get("reserve"), "食べログ"))
        put("phone", (t.get("phone"), "食べログ"))
        put("drinks", (t.get("drinks"), "食べログ"))
        put("opened", (t.get("opened"), "食べログ"))
        put("budget_dinner", (t.get("budget_dinner"), "食べログ"), (h.get("budget_dinner"), "ホットペッパー"))
        put("budget_lunch", (t.get("budget_lunch"), "食べログ"), (h.get("budget_lunch"), "ホットペッパー"))
        if t.get("score"):
            rec["score"] = t["score"]
        links = {}
        if t.get("url"):
            links["tabelog"] = t["url"]
        if h.get("url"):
            links["hotpepper"] = h["url"]
        for k, v in (("web", t.get("web") or e.get("web")), ("insta", e.get("insta")), ("x", e.get("x"))):
            if v and re.match(r"https?://", v):
                links[k] = v
        if links:
            rec["links"] = links

        # what reviews and articles say
        for k in ("catch", "crowd", "busy", "vibe", "first", "talk2"):
            if e.get(k):
                rec[k] = e[k]
                src[k] = "口コミ・記事"
        if e.get("rules"):
            rec["rules"] = [r for r in e["rules"] if r][:8]
        if e.get("menu"):
            rec["menu"] = [m for m in e["menu"] if m.get("n")][:6]
        if e.get("checked"):
            rec["checked_reviews"] = e["checked"]
        if e.get("status") in ("closed", "uncertain") and s["status"] == "open":
            rec["status_note"] = e["status"]
        fx = e.get("fix") or {}
        if isinstance(fx, dict):
            for k in ("desc", "talk", "tips", "price", "since"):
                if fx.get(k):
                    rec["fix_" + k] = fx[k]
        if e.get("sources_add"):
            rec["sources_add"] = [u for u in e["sources_add"] if isinstance(u, str) and u.startswith("http")][:4]
        if e:
            stats["enriched"] += 1
        rec["src"] = src
        out[sid] = rec

    with open(os.path.join(DATA, "info.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(" ".join(f"{k}={v}" for k, v in stats.items()), f"spots={len(spots)}", file=sys.stderr)


if __name__ == "__main__":
    main()
