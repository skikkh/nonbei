"""地域の候補台帳を地図と照合する。候補の営業や同一店舗を自動で断定しない。"""
import argparse
import json
import re
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def normalize(value):
    value = unicodedata.normalize('NFKC', value).casefold()
    value = ''.join(chr(ord(c) - 0x60) if 'ァ' <= c <= 'ヶ' else c for c in value)
    return re.sub(r'[\s・･（）()\-－ー]', '', value)


def compare(candidates, spots):
    by_id = {s['id']: s for s in spots}
    results = []
    for candidate in candidates:
        sid = candidate.get('spot_id')
        names = {normalize(n) for n in [candidate['name'], *candidate.get('aliases', [])] if n}
        area = normalize(candidate.get('area', ''))
        if sid:
            spot = by_id.get(sid)
            if not spot:
                results.append(('参照先なし', candidate, []))
            elif normalize(spot.get('name', '')) not in names or (area and area not in {
                    normalize(spot.get('area', '')), normalize(spot.get('ward', ''))}):
                results.append(('参照不一致', candidate, [spot]))
            else:
                results.append(('掲載あり' if spot.get('status') != 'closed' else '閉店掲載', candidate, [spot]))
            continue
        matches = [s for s in spots if normalize(s.get('name', '')) in names and
                   (not area or area in {normalize(s.get('area', '')), normalize(s.get('ward', ''))})]
        results.append(('候補一致・要確認' if matches else '一致未確認', candidate, matches))
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('ledger', type=Path, help='候補台帳のJSON')
    args = parser.parse_args()
    candidates = json.loads(args.ledger.read_text(encoding='utf-8'))
    spots = json.loads((ROOT / 'data/spots.json').read_text(encoding='utf-8'))['spots']
    results = compare(candidates, spots)
    for state, candidate, matches in results:
        ids = ', '.join(s['id'] for s in matches)
        print(f'{state}\t{candidate["name"]}\t{ids}')
    print(f'候補 {len(results)}件、一致未確認 {sum(s == "一致未確認" for s, _, _ in results)}件、参照不備 {sum(s in ("参照先なし", "参照不一致") for s, _, _ in results)}件')
    return int(any(s in ('参照先なし', '参照不一致') for s, _, _ in results))


if __name__ == '__main__':
    raise SystemExit(main())
