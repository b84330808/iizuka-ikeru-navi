# いいづか 行けるナビ

「どこへ、いつまでに行きたいか」から、飯塚市のコミュニティバス・エリアワゴン・予約乗合タクシーをまとめて判定し、今することを一つにする生活移動アシスタント。

## この作品の違い

- 通院・買い物・手続き・交流の4目的から施設を選び、現在地と到着希望時刻から間に合う便を逆算
- 市民向けの実用フローに「3分 審査デモ」を内蔵し、固定ケースから実検索・根拠・政策シミュレーションまで一続きで体験
- 定時便と予約交通を別々に探させず、一枚の「生活移動プラン」に統合
- 地区・利用日時・登録状況から、予約乗合タクシーの対象可否と次の行動を判定
- 電話（7日前）とネット（5日前）の受付条件を分け、利用登録・予約へ直接つなぐ
- PDF公開の穂波・菰田エリアワゴンを機械可読化して検索へ統合
- 目的地から3ステップで、乗る停留所・発車時刻・運賃・下車後の歩行まで案内
- 現在地から停留所まで歩く時間を含めて、実際に間に合う便だけを表示
- 運行終了・運休日・路線未接続を区別し、代替の予約交通と電話導線を表示
- 大きな文字、キーボード操作、読み上げ用ステータス、オフライン利用に対応
- 行政向け `LIFE TWIN` では、現行固定路線と穂波・菰田エリアワゴンを基準に、追加ワゴン1台を旧4路線のどこへ置くと最も多くの徒歩圏を回復できるかを比較

発表・実証の進め方は [`COMPETITION_PLAYBOOK.md`](COMPETITION_PLAYBOOK.md) を参照。
e-ZUKA スマートアプリコンテスト 2026 応募作品(分野: 福祉)。

## 構成

- `app/` — 静的 Web アプリ(そのまま GitHub Pages 等でホスト可能)
  - `index.html` + `app.js` — 3ステップ検索(行き先 → 乗る場所 → 時刻・運賃)。大きな文字、乗換対応、土日祝ダイヤ対応
  - `analysis.html` + `killer_map.html` — データで見る交通課題(2022年廃線の影響分析)
  - `future.html` + `wagon-scenarios.json` — 新旧GTFSと国勢調査から算出する「追加ワゴン1台」の配置デモ
  - `data.js` — ビルド済みデータ(GTFS 2路線 + 施設一覧 + 分析結果)
- `scripts/`
  - `build_analysis.py` — 廃線前後のバス停300m徒歩圏 × 町丁別高齢者人口の疊圖生成
  - `build_app_data.py` — GTFS・施設CSVから `app/data.js` を生成
  - `build_wagon_scenarios.py` — 旧4路線から乗降6地点を選び、回復する300m徒歩圏と高齢者人口を比較
  - `test_engine.mjs` — 検索エンジンのヘッドレステスト(`node scripts/test_engine.mjs`)
- `data/` — オープンデータ(BODIK / e-Stat 由来)

## ビルド

```
pip install shapely pyshp folium
python scripts/build_analysis.py   # 分析 + killer_map.html
python scripts/build_app_data.py   # app/data.js
python scripts/build_wagon_scenarios.py # app/wagon-scenarios.json
cp output/killer_map.html app/
node scripts/test_engine.mjs       # テスト
```

ローカル起動(PowerShell):

```powershell
python -m http.server 4173 -d app
```

市民向けは `http://localhost:4173/`、LIFE TWIN は `http://localhost:4173/future.html` で開く。

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
