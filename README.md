# 東京のんべえ地図

東京の立ち飲み・角打ち・せんべろ（千円でべろべろ）の大衆酒場・飲み屋横丁・小さなバーを、**人と話しやすいか**で探せる夜の地図です。

公開ページ: https://skikkh.github.io/nonbei/

収録は402件（2026年10月調査）。そのうち営業中の392件を地図に載せています（立ち飲み132・せんべろ107・横丁53・バーとスナック41・角打ち30・交流酒場29）。閉店・移転などで外した10件も記録として残しています。全店に「話しやすさ」を5段階で付けていて、4以上は269件です。

## 一軒ごとの情報

| 項目 | 出どころ | 件数 |
|---|---|---|
| 紹介文・話しやすさ・人と話すコツ・行き方 | 公式サイト・記事・口コミを読み比べた調査（`research/`） | 392 |
| 曜日ごとの営業時間（今営業中の判定に使う） | 食べログ196・ホットペッパー15・調査メモの営業時間を解析75 | 286 |
| 支払い方法・席数・喫煙・チャージ・予約・電話 | 食べログとホットペッパーの店舗ページ（住所で照合） | 支払い290・席166・喫煙244・チャージ202 |
| 見出し・店の様子・客層・混む時間・品書きと値段・店の決まり・はじめての人へ | 2026年の口コミと記事の要約（`data/enrich.json`） | 様子391・客層373・混む時間316・品書き374・決まり234 |

店のページには項目ごとに出典（食べログ・ホットペッパー・調査・口コミ記事）を表示し、出典URLと確認日を載せています。今営業中かどうかは、東京の現在時刻と祝日・祝前日を考えて判定します。

## 地図

- 背景地図は OpenStreetMap のデータからこのリポジトリで描いたベクター地図です（MapLibre GL）。夜は藍墨の地に店の灯り、昼は生成りの和紙に墨の配色です。
- 店は種類ごとの提灯で描き、灯りの大きさが話しやすさです。横丁には縦書きの看板が付き、OSM の区画や路地の形も描きます。
- 店の周りだけは路地・階段・建物の高さまで描きます。OSM に登録されている飲み屋（約1万件、未検証）も、拡大すると小さな点で出ます。

### 位置の決め方と精度

1. 店名で OpenStreetMap の飲食店・酒屋・宿を探し、住所の近く（建物単位の住所なら40m以内を優先）にあればその点を使う
2. なければ国土地理院の住所検索で、住所の建物位置（「号」）か街区（「番」）を使う
3. 食べログの店舗地図の座標と突き合わせる。住所が街区までしか分からない店は、食べログの座標を使う

食べログの座標と照合できた209軒では、位置の差の中央値は7m、9割が24m以内でした。同じ番地の店（ゴールデン街など）は、ピンが重ならないよう数mずらしています。

## 話しやすさ

| 値 | 目安 |
|---|---|
| 5 | 極小店・コの字カウンター・店主が客をつなぐなど、自然に会話が生まれる |
| 4 | 立ち飲み・カウンター中心で、隣の客や常連と話しやすい |
| 3 | 混雑時の相席などで、隣と話すこともある |
| 2 | グループ客中心だが、一人でも入れる |
| 1 | 会話より安さと味 |

## 構成

```
research/*.json            エリア別の調査結果（出典付きの元データ）と調査仕様 SPEC.md
data/spots.json            店と横丁（ジオコーディング済み）
data/overrides.json        手作業の補正（位置・営業状況・収録除外）
data/tabelog.json          食べログの店舗ページから取り込んだ営業時間・支払い・席・喫煙・チャージなど
data/hotpepper.json        ホットペッパーの店舗ページから取り込んだ同じ項目
data/enrich.json           口コミと記事の要約（客層・混む時間・品書き・店の決まり…）
data/geocode_cache.json    国土地理院・Overpass の検索結果キャッシュ（再現用）
site/src/                  ページ（page.html, style.css, atlas.js＝地図の描画, app.js）
site/data/                 背景地図（base.json, base_hi.json）と街路・建物のチャンク（c/, b/）
promo/                     縦動画（reel.html を1コマずつ撮影する capture.js、encode.sh、投稿キット KIT.md）
scripts/                   データ取得と生成のスクリプト
```

## 作り直し方

```sh
pip install shapely
python3 scripts/fetch_base.py                 # OSM から背景データ（Overpass）
python3 scripts/fetch_detail.py pois streets  # OSM の飲み屋と生活道路
python3 scripts/build_basemap.py              # → site/data/base.json, base_hi.json
python3 scripts/build_spots.py "research/*.json"   # → data/spots.json（ジオコーディング）
python3 scripts/tabelog_coords.py             # 食べログの店舗地図の座標（照合用）
python3 scripts/build_spots.py "research/*.json"   # 照合結果を反映
python3 scripts/check_spots.py                # 範囲外・区の不一致・出典なしなどを検査
python3 scripts/spot_points.py > .cache/points.json
python3 scripts/fetch_detail.py around .cache/points.json   # 店の周りの路地と建物
python3 scripts/build_chunks.py               # → site/data/c/, site/data/b/
python3 scripts/tabelog_fetch.py && python3 scripts/tabelog_parse.py   # → data/tabelog.json
python3 scripts/hotpepper.py                  # → data/hotpepper.json
python3 scripts/merge_enrich.py <要約の出力ディレクトリ>   # → data/enrich.json
python3 scripts/build_site.py                 # → dist/site/（GitHub Pages にそのまま置ける）
```

`build_site.py` は `build_info.py` を呼んで、店ごとの情報（`data/info.json`）を組み立ててからページを書き出します。公開は GitHub Actions（`.github/workflows/pages.yml`）が、main に push されるたびに `dist/site/` をこのリポジトリの GitHub Pages に載せます（Settings → Pages の Source は「GitHub Actions」）。skikkh.github.io リポジトリに置く場合は `scripts/publish_pages.sh` を使います。

縦動画は `npm i playwright` のあと `node promo/capture.js frames` で900コマを撮り、`sh promo/encode.sh` で mp4 にします。

## データと出典

- 地図データ: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors（ODbL）
- 住所の位置: [国土地理院 住所検索API](https://msearch.gsi.go.jp/)
- 店の情報: 2026年10月に、公式サイト・公式SNS・食べログ・ホットペッパー・記事・口コミで確かめて作成。出典は各店の `sources` と店のページにあります。営業時間や値段は変わるので、行く前に確認してください。

お酒は二十歳になってから。飲んだら乗らない。
