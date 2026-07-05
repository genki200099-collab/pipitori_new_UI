# ピピトリ｜Pig Pick Trick Online

添付仕様をもとにした、Render デプロイ対応のブラウザ版カードゲームです。

## 起動方法

```bash
npm install
npm start
```

ブラウザで `http://localhost:3000` を開きます。

## Render デプロイ

1. このフォルダを GitHub リポジトリにアップロード
2. Render で New Web Service を作成
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Node は `package.json` の `22.x` を使用

## 実装内容

- Node.js + WebSocket (`ws`)
- 4人用オンライン部屋作成 / 入室
- CPU追加、CPU3キャラ画像
- 添付画像風の横長カードゲームUI
- りんご / どろんこ / キャベツ / トウモロコシのスート
- マストフォロー
- 勝者判定 / 最弱判定
- 公開ピック
- ピック対象数ルール
- ピック後ペア浄化
- 開始時3枚パス
- 開始時ペア捨て
- ババブタ失点タイミング
- マッド・ピッグ
- シュート・ザ・ピッグ演出
- ラウンド結果 / 最終結果
- CPUの性格別カード選択・セリフ

## ファイル構成

```text
server.js
package.json
.npmrc
README.md
public/
  index.html
  pig_pick_trick_logo.png
  cpu_characters/
    kamomodoki.jpg
    wakumodoki.jpg
    rikumodoki.png
```

## CPUセリフ強化

CPU3キャラは、選択ルール・手札リスク・場面・プレイヤー名を参照して発言します。
かももどきは攻撃的、ワクもどきは大胆、リクもどきは堅実な傾向で、公開ピックやシュート・ザ・ピッグ時にも場を盛り上げるコメントをします。
