# 東京のんべえ地図

東京の飲み屋横丁・センベロ（千円でべろべろ）の大衆酒場・立ち飲み・角打ち・小さなバーを集めた地図です。
**人と話しやすいかどうか**を「交流度」（5段階）として全店に付け、それで絞り込めます。

- 店ごとに、住所・最寄駅からの距離・営業時間・定休日・予算・名物と値段・支払い方法・喫煙・創業年・「人と話すコツ」・出典URL・営業確認のメモを載せています。
- 位置は OpenStreetMap の店舗・建物データと国土地理院の住所ジオコーダを突き合わせて決め、どちらで決まったかを詳細に表示します。横丁は OSM の区画や路地の形をそのまま描きます。
- 背景地図は OpenStreetMap のデータからこのリポジトリで生成したベクター地図です。タイルサーバーを使わないので、外部画像を読めない環境でも動きます。路地・階段・建物まで描くのは店の周辺だけです。
- OSM に登録されている飲み屋（約1万件、未検証）も、拡大すると小さな点で表示します。

## 交流度

| 値 | 目安 |
|---|---|
| 5 | 極小店・コの字カウンター・店主が客をつなぐなど、自然に会話が生まれる |
| 4 | 立ち飲み・カウンター中心で、隣の客や常連と話しやすい |
| 3 | 混雑時の相席などで、隣と話すこともある |
| 2 | グループ客中心だが、一人でも入れる |
| 1 | 交流はほぼない（安さ・味が目的） |

## 構成

```
data/spots.json            店と横丁のデータ（ジオコーディング済み。ページに埋め込む）
data/overrides.json        手作業の補正（位置・営業状況の更新・収録除外）
data/geocode_cache.json    国土地理院・Overpass の検索結果キャッシュ（再現用）
data/review.txt            位置に注意が必要な店の一覧
research/*.json            エリア別の調査結果（出典付きの元データ）と調査仕様 SPEC.md
site/src/                  ページ本体（page.html, style.css, map.js, app.js）
site/data/base.json        広域の背景地図（z12 まで）と駅名・地名
site/data/base_hi.json     東京の詳しい背景地図（z13 から読み込む）
site/data/c/{x}_{y}.json   z12 タイル単位の街路・丁目名・OSM の飲み屋（z13 から）
site/data/b/{x}_{y}.json   z13 タイル単位の建物・路地・階段（店の周辺のみ、z15 から）
scripts/                   データ取得と生成のスクリプト
```

## 作り直し方

```sh
pip install shapely
python3 scripts/fetch_base.py                 # OSM から背景データ（Overpass）
python3 scripts/fetch_detail.py pois streets  # OSM の飲み屋と生活道路
python3 scripts/build_basemap.py              # → site/data/base.json, base_hi.json
python3 scripts/build_spots.py "research/*.json"   # → data/spots.json（ジオコーディング）
python3 scripts/check_spots.py                # 範囲外・区の不一致・出典なしなどを検査
python3 scripts/spot_points.py > .cache/points.json
python3 scripts/fetch_detail.py around .cache/points.json   # 店の周りの路地と建物
python3 scripts/build_chunks.py               # → site/data/c/, site/data/b/
python3 scripts/build_site.py                 # → dist/artifact/ と dist/pages/
```

## データと出典

- 地図データ: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors（ODbL）
- 住所の位置: [国土地理院 住所検索API](https://msearch.gsi.go.jp/)
- 航空写真（Pages 版のみ）: [地理院タイル](https://maps.gsi.go.jp/development/ichiran.html)
- 店の情報: 2026年10月に、公式サイト・公式SNS・グルメサイト・記事などで営業状況を確かめて作成。出典は各店の `sources` に入っています。営業時間や価格は変わるので、行く前に確認してください。

お酒は20歳になってから。飲んだら乗らない。
