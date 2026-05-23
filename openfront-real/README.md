# ⚔ OpenFront Clone

**Based on OpenFront / © OpenFront and Contributors**
Source: https://github.com/openfrontio/OpenFrontIO
License: GNU Affero General Public License v3.0 (AGPL-3.0)

本物のOpenFrontIOのソースコード・マップデータ・ゲームロジックを忠実に移植したマルチプレイ領土制圧ゲームです。

---

## 実装済みメカニクス（Config.tsより完全移植）

| 項目 | 本家の値 |
|------|---------|
| 兵力成長式 | `(10 + pop^0.73/4) × (1 - pop/maxPop)` |
| 最大兵力 | `2×(tiles^0.6×1000+50000) + cities×250000` |
| ゴールド | 人間100G/tick・Bot50G/tick（100ms/tick） |
| 同盟期間 | 300秒（3000tick） |
| 裏切りペナルティ | 30秒・防御debuff×0.5 |
| 防衛ポスト範囲 | 30タイル・防御×5・速度×3 |
| SAM射程 | 70タイル・CD90tick |
| 迎撃率 | 原子100%・水素50%・MIRV30% |
| 核半径 | 原子outer30・水素outer100・MIRV outer18×3発 |
| 勝利条件 | 陸地80%占領 |
| 包囲殲滅 | 囲み完了→即時全占領+gold吸収 |
| マップ | europe/asia/world（本物のバイナリmap16x.bin使用）|

---

## 無料デプロイ手順（永久無料）

### 1. GitHubにアップロード
1. https://github.com → New repository → `openfront-clone` → Public
2. 「uploading an existing file」→ このフォルダを全部ドラッグ
3. Commit changes

### 2. Renderでデプロイ
1. https://render.com → GitHub連携
2. New → Web Service → `openfront-clone` 選択
3. 自動検出でそのままデプロイ
4. URLが発行される（例: `https://openfront-clone-xxxx.onrender.com`）

### 3. UptimeRobotでスリープ防止（無料）
1. https://uptimerobot.com → Add Monitor
2. Type: HTTP(s)・URL: RenderのURL・Interval: 5 minutes
3. → 24時間365日起動維持

---

## 操作方法

| 操作 | 内容 |
|------|------|
| 左クリック | タイル選択 |
| 右クリック（自分の領土） | 建設メニュー |
| 中/右ドラッグ | マップ移動 |
| スクロール | ズーム |
| WASD/矢印キー | パン |
| A | 攻撃 |
| L | 同盟申請 |
| N | 核攻撃モード |
| ESC | キャンセル |

---

## 建物コスト

| 建物 | コスト式 | 上限 |
|------|---------|------|
| 都市 | 125K × 2^n | 1M |
| 港 | 125K × 2^n | 1M |
| 防衛ポスト | 50K × (n+1) | 250K |
| ミサイルサイロ | 1M | — |
| SAM | 1.5M × (n+1) | 3M |
| 原子爆弾 | 750K | — |
| 水素爆弾 | 5M | — |
| MIRV | 25M + 15M×n | — |
