# ⚔ OpenFront Clone — マルチプレイ領土制圧ゲーム

> **Based on OpenFront** (openfrontio/OpenFrontIO) — AGPL-3.0 License  
> 友達と無料でプレイできる、ブラウザベースのリアルタイム戦略ゲームです。

---

## 🎮 ゲーム内容

- 🗺 ランダム生成マップで最大8人（＋Botで最大21人）
- ⚔ 隣接領土をクリックして攻撃・占領
- 🤝 同盟システム（裏切るとペナルティ！）
- ☢ 核兵器（ゴールドを貯めて購入）
- 📊 リーダーボード・ミニマップ・チャット
- 🎛 カスタマイズ可能（Bot数、難易度、勝利条件など）

---

## 🚀 無料で公開する方法（初心者向け）

### 方法A：Railway（おすすめ・最も簡単）

友達がどこからでもアクセスできるURLが手に入ります。**完全無料**。

#### ステップ1：GitHubにアップロード

1. **https://github.com** にアクセス → 「Sign up」で無料登録
2. 「New repository」をクリック
3. Repository name: `openfront-clone`
4. 「Public」を選択 → 「Create repository」
5. 「uploading an existing file」をクリック
6. このフォルダの中の全ファイルをドラッグ＆ドロップ
   - `server.js`
   - `package.json`
   - `public/index.html`（publicフォルダごとドロップ）
7. 「Commit changes」をクリック

#### ステップ2：Railwayでデプロイ

1. **https://railway.app** にアクセス → 「Login with GitHub」
2. 「New Project」→「Deploy from GitHub repo」
3. `openfront-clone` を選択
4. 自動でデプロイ開始！1〜2分待つ
5. 「Settings」→「Networking」→「Generate Domain」をクリック
6. `https://openfront-clone-xxxx.up.railway.app` というURLができる

#### ステップ3：友達に共有

そのURLを友達にLINEで送るだけ！ルームコードで合流できます。

---

### 方法B：ローカル（LAN内・家の中だけ）

```bash
# Node.jsをインストール後（https://nodejs.org）
npm install
node server.js
```

ブラウザで `http://localhost:3000` を開く。  
同じWi-Fiの友達は `http://あなたのIPアドレス:3000` でアクセス可。

---

## 🎮 遊び方

| 操作 | 内容 |
|------|------|
| 左クリック | 領土を選択してターゲット |
| ⚔ ATTACK | 選択した領土を攻撃 |
| 🤝 ALLY | 同盟を申し込む |
| ☢ NUKE | 核攻撃（要ゴールド） |
| 右クリックドラッグ | マップ移動 |
| スクロール | ズームイン/アウト |

**勝利条件：** マップの80%（設定変更可）を占領する

---

## ⚙ カスタマイズ

ルーム作成時に設定できます：
- **Bot数**：1〜13体
- **Bot難易度**：Easy / Normal / Hard
- **勝利条件**：50〜90%
- **核コスト**：500〜5000ゴールド
- **自分の国の色**：自由に設定

---

## 📜 ライセンス

このゲームは [OpenFront](https://github.com/openfrontio/OpenFrontIO) をベースにしています。  
ライセンス：GNU Affero General Public License v3.0 (AGPL-3.0)

Loading/起動時に表示：**"Based on OpenFront / © OpenFront and Contributors"**

---

## 🛠 ファイル構成

```
openfront-clone/
├── server.js        ← ゲームサーバー（Node.js + WebSocket）
├── package.json     ← 依存関係
└── public/
    └── index.html   ← ゲームクライアント（全部入り）
```

---

*Enjoy the game! 🌍⚔*
