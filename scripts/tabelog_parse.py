"""Turn cached English Tabelog pages into Japanese structured shop facts.

Writes data/tabelog.json: {spot id: {...}}. Fields (all optional):
  url, score, phone, reserve, week, hours, closed_note, budget_dinner,
  budget_lunch, pay, cash_only, charge, seats, seating, smoking, drinks,
  web, opened, categories
`week` maps mon..sun, hol (public holiday), prehol (day before one) to a
list of [open, close, last_order] in minutes from midnight (close may pass
24:00). The page shows "今営業中" from it.
usage: python3 scripts/tabelog_parse.py
"""
import html
import json
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
CACHE = os.path.join(ROOT, ".cache", "tabelog")
SHOP = re.compile(r"tabelog\.com/(?:en/)?(tokyo/A\d+/A\d+/(\d{8}))")

DAYS = {"Mon": "mon", "Tue": "tue", "Wed": "wed", "Thu": "thu", "Fri": "fri", "Sat": "sat", "Sun": "sun",
        "Public Holiday": "hol", "Day before public holiday": "prehol", "Day after public holiday": "posthol"}
JP_DAY = {"mon": "月", "tue": "火", "wed": "水", "thu": "木", "fri": "金", "sat": "土", "sun": "日",
          "hol": "祝", "prehol": "祝前日", "posthol": "祝後日"}
ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun", "hol", "prehol", "posthol"]
DAY_RE = r"(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Public Holiday|Day before public holiday|Day after public holiday)"
TIME = r"\d{1,2}:\d{2} [AP]M"


def clean(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()


def original(s):
    """Japanese 'Original text' that Tabelog keeps next to machine translations."""
    m = re.search(r"Original text\s+(.*?)\s+This section has been automatically translated", s)
    return m.group(1).strip() if m else None


def minutes(t):
    h, m, ap = re.match(r"(\d{1,2}):(\d{2}) ([AP]M)", t).groups()
    h, m = int(h) % 12, int(m)
    if ap == "PM":
        h += 12
    return h * 60 + m


def fmt(m):
    return f"{m // 60}:{m % 60:02d}"


def parse_hours(text):
    week, notes = {}, []
    pat = re.compile(rf"(?P<days>{DAY_RE}(?:,\s*{DAY_RE})*)\s+(?P<body>Closed|Open 24 hours|(?:{TIME} - {TIME}"
                     rf"(?:\s+L\.O\.\s+(?:Food\s+)?{TIME}(?:\s+Drinks\s+{TIME})?)?\s*)+)")
    pos = 0
    for m in pat.finditer(text):
        days = [DAYS[d.strip()] for d in m.group("days").split(",")]
        body = m.group("body").strip()
        if body == "Closed":
            ranges = []
        elif body == "Open 24 hours":
            ranges = [[0, 24 * 60, None]]
        else:
            ranges = []
            for r in re.finditer(rf"({TIME}) - ({TIME})(?:\s+L\.O\.\s+(?:Food\s+)?({TIME})(?:\s+Drinks\s+({TIME}))?)?", body):
                o, c = minutes(r.group(1)), minutes(r.group(2))
                if c <= o:
                    c += 24 * 60
                lo = r.group(4) or r.group(3)
                lo = minutes(lo) if lo else None
                if lo is not None and lo < o:
                    lo += 24 * 60
                ranges.append([o, c, lo])
        for d in days:
            week[d] = ranges
        pos = m.end()
    rest = text[pos:]
    for n in re.split(r"■", rest):
        n = n.strip()
        n = re.sub(r"Hours and closed days may change, so please check with the restaurant before visiting\.?", "", n).strip()
        if n:
            notes.append(n)
    return week, notes


def hours_text(week):
    """'月〜土 17:00〜23:00（L.O.22:30）／日 定休' style summary."""
    keyed = []
    for d in ORDER:
        if d not in week:
            continue
        r = week[d]
        key = "定休" if not r else "・".join(
            f"{fmt(o)}〜{fmt(c)}" + (f"（L.O.{fmt(lo)}）" if lo is not None else "") for o, c, lo in r)
        keyed.append((d, key))
    groups = []
    for d, key in keyed:
        last = groups[-1][0][-1] if groups else None
        consecutive = last in ORDER[:7] and d in ORDER[:7] and ORDER.index(d) == ORDER.index(last) + 1
        if groups and groups[-1][1] == key and (consecutive or (d == "hol" and last in ORDER[:7] + ["hol"])):
            groups[-1][0].append(d)
        else:
            groups.append(([d], key))
    out = []
    for ds, key in groups:
        wk = [x for x in ds if x in ORDER[:7]]
        extra = [x for x in ds if x not in ORDER[:7]]
        if len(wk) > 2:
            label = JP_DAY[wk[0]] + "〜" + JP_DAY[wk[-1]]
        else:
            label = "・".join(JP_DAY[x] for x in wk)
        if extra:
            label = "・".join([label] + [JP_DAY[x] for x in extra]) if label else "・".join(JP_DAY[x] for x in extra)
        out.append(f"{label} {key}")
    return "／".join(out)


def parse_pay(td_html):
    t = clean(td_html)
    card = re.search(r"Credit card accepted(?: \(([^)]*)\))?", t)
    emoney = re.search(r"Electronic money accepted(?: \(([^)]*)\))?", t)
    qr = re.search(r"QR code payments accepted(?: \(([^)]*)\))?", t)
    parts = []
    if card:
        parts.append("カード" + (f"（{card.group(1).replace(', ', '・')}）" if card.group(1) else ""))
    if emoney:
        em = (emoney.group(1) or "")
        em = em.replace("Transportation IC cards (e.g., Suica", "交通系IC").replace(", ", "・")
        parts.append("電子マネー" + (f"（{em}）" if em else ""))
    if qr:
        parts.append("QR決済" + (f"（{qr.group(1).replace(', ', '・').replace('d Barai', 'd払い').replace('Rakuten Pay', '楽天ペイ').replace('au PAY', 'au PAY')}）" if qr.group(1) else ""))
    known = any(k in t for k in ("Credit card", "Electronic money", "QR code"))
    if not known:
        return None, None
    cash_only = not parts and "Credit cards not accepted" in t
    return ("現金のみ" if cash_only else "現金・" + "・".join(parts) + "可") if (parts or cash_only) else None, cash_only


SEAT_WORDS = [("Counter", "カウンター"), ("Table", "テーブル"), ("Standing", "立ち"), ("Tatami room", "座敷"),
              ("Tatami", "座敷"), ("Sofa", "ソファ"), ("Terrace", "テラス"), ("seats", "席"), ("seat", "席"),
              ("people", "人"), ("person", "人"), ("approx.", "約"), ("Approx.", "約"), ("1st floor", "1階"),
              ("2nd floor", "2階"), ("3rd floor", "3階"), ("Basement", "地下")]
FACILITY = {"Counter seating": "カウンター席", "Standing": "立ち飲み", "Sofa seating": "ソファ席",
            "Terrace seating": "テラス席", "Open terrace": "テラス", "Tatami seating": "座敷",
            "Sunken kotatsu seating": "掘りごたつ", "Spacious seating": "ゆったり席", "Stylish space": "おしゃれ空間",
            "Relaxing space": "落ち着いた空間", "Free Wi-Fi available": "Wi-Fi", "Power outlets available": "電源",
            "Karaoke available": "カラオケ", "Live music": "ライブ", "Sports viewing": "スポーツ観戦",
            "Wheelchair accessible": "車椅子可", "Seats with a beautiful view": "眺望席", "Night view": "夜景",
            "Hideaway restaurant": "隠れ家"}
DRINK = {"Sake (Nihonshu)": "日本酒", "Shochu (Japanese spirits)": "焼酎", "Wine": "ワイン", "Cocktails": "カクテル",
         "Particular about sake (Nihonshu)": "日本酒にこだわり", "Particular about shochu (Japanese spirits)": "焼酎にこだわり",
         "Particular about wine": "ワインにこだわり", "Particular about cocktails": "カクテルにこだわり",
         "Awamori (Okinawan spirits)": "泡盛", "Whiskey": "ウイスキー", "Craft beer": "クラフトビール"}


def parse_seats(t):
    m = re.match(r"(\d+)\s*seats?", t)
    if not m:
        return None, None
    note = None
    p = re.search(r"\((.*)\)", t)
    if p:
        note = p.group(1).strip()
        for a, b in SEAT_WORDS:
            note = note.replace(a, b)
        if re.search(r"[A-Za-z]{3,}", note):
            note = None  # leftover translation prose; keep the number only
    return int(m.group(1)), note


def parse_smoking(t):
    if not t:
        return None
    if t.startswith("Non smoking") or "No smoking" in t:
        return "全席禁煙"
    if "Separate smoking" in t or "Smoking room" in t or "smoking area" in t.lower():
        return "分煙・喫煙所あり"
    if "Smoking allowed" in t or "Smoking is allowed" in t:
        return "喫煙可"
    return None


def yen_range(s):
    m = re.findall(r"JPY ([\d,]+)", s)
    if len(m) == 2:
        return f"¥{m[0]}〜¥{m[1]}"
    if len(m) == 1:
        return f"〜¥{m[0]}" if s.strip().startswith(("-", "~", "～")) else f"¥{m[0]}〜"
    return None


def parse_page(path):
    p = open(path, encoding="utf-8", errors="replace").read()
    rows = {}
    for th, td in re.findall(r"<th[^>]*>(.*?)</th>\s*<td[^>]*>(.*?)</td>", p, re.S):
        rows.setdefault(clean(th), td)
    out = {}
    sc = re.search(r'rdheader-rating__score-val-dtl[^>]*>([0-9.]+)<', p)
    if sc:
        out["score"] = float(sc.group(1))
    for k in ("Phone number (for reservation and inquiry)", "Phone number", ""):
        if k in rows:
            ph = re.search(r"0\d{1,4}-\d{1,4}-\d{3,4}", clean(rows[k]))
            if ph:
                out["phone"] = ph.group(0)
                break
    r = clean(rows.get("Reservation availability", ""))
    if r:
        out["reserve"] = "予約不可" if "unavailable" in r else "完全予約制" if "only" in r.lower() else "予約可" if "available" in r else None
    hrs = clean(rows.get("Business hours", ""))
    if hrs:
        week, notes = parse_hours(hrs)
        if week:
            out["week"] = week
            out["hours"] = hours_text(week)
        jn = original(hrs)
        if jn:
            out["hours_note"] = jn
    budget = rows.get("Average price")
    if budget:
        for kind, key in (("Dinner", "budget_dinner"), ("Lunch", "budget_lunch")):
            m = re.search(rf'aria-label="{kind}"[^>]*></i><em>(.*?)</em>', budget, re.S)
            if m:
                v = yen_range(clean(m.group(1)))
                if v:
                    out[key] = v
    if "Payment methods" in rows:
        pay, cash = parse_pay(rows["Payment methods"])
        if pay:
            out["pay"] = pay
            out["cash_only"] = bool(cash)
    ch = rows.get("Service charge & fee")
    if ch:
        jo = original(clean(ch))
        if jo and jo not in ("なし", "無し", "ありません"):
            out["charge"] = jo
        elif jo:
            out["charge"] = "チャージなし"
    seats = clean(rows.get("Number of seats", ""))
    if seats:
        n, note = parse_seats(seats)
        if n:
            out["seats"] = n
            if note:
                out["seats_note"] = note
    sp = clean(rows.get("Space/facilities", ""))
    if sp:
        fac = [FACILITY[x.strip()] for x in sp.split(",") if x.strip() in FACILITY]
        if fac:
            out["seating"] = fac
    sm = parse_smoking(clean(rows.get("Non-smoking/smoking", "")))
    if sm:
        out["smoking"] = sm
    dr = clean(rows.get("Drink", ""))
    if dr:
        d = [DRINK[x.strip()] for x in dr.split(",") if x.strip() in DRINK]
        if d:
            out["drinks"] = d
    web = re.search(r'href="(https?://[^"]+)"', rows.get("Website", ""))
    if web and "tabelog.com" not in web.group(1):
        out["web"] = html.unescape(web.group(1))
    op = clean(rows.get("The opening day", ""))
    if op:
        out["opened"] = op
    cat = clean(rows.get("Categories", ""))
    if cat:
        out["categories"] = cat
    return out


def main():
    spots = json.load(open(os.path.join(ROOT, "data", "spots.json"), encoding="utf-8"))["spots"]
    extra = {}
    xp = os.path.join(ROOT, "data", "tabelog_urls.json")  # urls found later by research
    if os.path.exists(xp):
        extra = json.load(open(xp, encoding="utf-8"))
    res, stats = {}, {}
    for s in spots:
        urls = list(s.get("sources") or []) + ([extra[s["id"]]] if s["id"] in extra else [])
        m = next((SHOP.search(u) for u in urls if SHOP.search(u)), None)
        if not m or s["kind"] == "yokocho":
            continue
        path = os.path.join(CACHE, m.group(2) + ".html")
        if not os.path.exists(path):
            continue
        info = parse_page(path)
        info["url"] = "https://tabelog.com/" + m.group(1) + "/"
        res[s["id"]] = info
        for k in info:
            stats[k] = stats.get(k, 0) + 1
    json.dump(res, open(os.path.join(ROOT, "data", "tabelog.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{len(res)} shops", sorted(stats.items(), key=lambda x: -x[1]), file=sys.stderr)


if __name__ == "__main__":
    main()
