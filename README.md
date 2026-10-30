# 帰る

ボタンはひとつ。押すと **現在地から家まで** の経路だけを出す、iPhone 向けのアプリです。
Safari で開いて「ホーム画面に追加」するとアプリのように使えます。

## しくみ

```
iPhone ──▶ Cloudflare Worker ──▶ 現在地の住所・最寄り駅（国土地理院 / HeartRails）
                              └─▶ Yahoo!乗換案内（住所 → 家）
```

- 経路の取得・解析は [のりかえ](https://github.com/weakestandstrongest-sketch/norikae) の `src/yahoo.js` などをそのまま使っています
- 現在地の住所から家まで探し、見つからなければ近い駅（2 つまで）から探します
- 家の場所（駅名・バス停・住所）は端末の中（localStorage）にだけ保存します

## 使い方

1. 「帰る」を押す（はじめてのときは家の場所を聞かれます）
2. 家に着く時刻・出発までの残り時間・乗る電車がタイムラインで出ます
3. 家の場所を変えたいときは、ボタンの下の「家 · ○○」を押す

## 公開方法（Cloudflare Workers・無料）

1. Cloudflare ダッシュボードの **Workers & Pages → 作成 → Import a repository** でこのリポジトリを選ぶ
2. 設定はそのままで **Deploy**（デプロイコマンドは `npx wrangler deploy`）
3. 表示された `https://ie.<サブドメイン>.workers.dev` を iPhone の Safari で開き、共有 →「ホーム画面に追加」

## 開発

```sh
npm install
npm test      # テスト
npm run dev   # http://localhost:8787
```

- `public/` … 画面（HTML / CSS / JS）
- `src/index.js` … Worker（`/api/home` `/api/suggest` `/api/where`）
- `src/yahoo.js` `src/suggest.js` `src/nearest.js` … のりかえから流用

個人利用を前提にしています。URL を広く公開しないでください。
