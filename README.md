# いいづか のりものナビ

飯塚市のコミュニティバス・乗合タクシーで「病院・市役所へ行く」ための、高齢者にやさしい乗り物案内 Web アプリ。
e-ZUKA スマートアプリコンテスト 2026 応募作品(分野: 福祉)。

## 構成

- `app/` — 静的 Web アプリ(そのまま GitHub Pages 等でホスト可能)
  - `index.html` + `app.js` — 3ステップ検索(行き先 → 乗る場所 → 時刻・運賃)。大きな文字、乗換対応、土日祝ダイヤ対応
  - `analysis.html` + `killer_map.html` — データで見る交通課題(2022年廃線の影響分析)
  - `data.js` — ビルド済みデータ(GTFS 2路線 + 施設一覧 + 分析結果)
- `scripts/`
  - `build_analysis.py` — 廃線前後のバス停300m徒歩圏 × 町丁別高齢者人口の疊圖生成
  - `build_app_data.py` — GTFS・施設CSVから `app/data.js` を生成
  - `test_engine.mjs` — 検索エンジンのヘッドレステスト(`node scripts/test_engine.mjs`)
- `data/` — オープンデータ(BODIK / e-Stat 由来)

## ビルド

```
pip install shapely pyshp folium
python scripts/build_analysis.py   # 分析 + killer_map.html
python scripts/build_app_data.py   # app/data.js
cp output/killer_map.html app/
node scripts/test_engine.mjs       # テスト
```

アプリは `app/index.html` をブラウザで開くだけで動く(全データ埋め込み済み・サーバ不要)。

## データ出典

| データ | 出典 |
|---|---|
| コミュニティバス GTFS-JP(現行2路線・廃止4路線) | [BODIK 飯塚市](https://data.bodik.jp/dataset?organization=402052) |
| 医療機関一覧・公共施設一覧 | 同上 |
| 町丁別年齢別人口 | 令和2年国勢調査 小地域集計(e-Stat, T001082) |
| 町丁字等境界 | e-Stat 統計GIS |
| 市民意識調査 | 飯塚市(令和5年度) |

## 分析ハイライト

2022年3月のコミュニティバス再編(5路線→2路線)で、バス停 116→76。
34町丁で300m徒歩圏が消滅し、面積按分推計で約3,500人の65歳以上が固定路線バスの徒歩圏を失った。
詳細は `app/analysis.html`。
