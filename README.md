# tabi. — 旅のスケジューラー

行き先・旅行期間・旅のペース・興味のあることから、OpenAI API（`gpt-6-luna`）で日ごとの旅程を自動生成するWebアプリです。旅程の追加・編集・削除、日程の追加・削除、並べ替え、ブラウザー内への保存、テキストコピーに対応しています。

## Dockerで起動

Docker Desktopを起動し、`.env.example` を `.env` にコピーして `OPENAI_API_KEY` にOpenAI APIキーを設定してから、プロジェクトのディレクトリで実行してください。

```sh
cp .env.example .env
# .env の OPENAI_API_KEY を設定
docker compose -p tabi up --build -d
```

ブラウザーで <http://localhost:8082> を開きます。`.env` はGitに登録されないため、APIキーが公開リポジトリに含まれることはありません。ポートを変える場合は `.env` の `PORT` を変更します。

PowerShellの場合、`.env` の作成は `Copy-Item .env.example .env` で行えます。

## 旅程の生成について

入力した行き先、日程、興味、旅のペースをOpenAI APIに送信して旅程を生成します。APIの利用料金はOpenAIアカウントに請求されます。リアルタイムの営業状況・天気・交通情報は取得しないため、予約や訪問前に現地情報を確認してください。保存データはブラウザーのLocalStorageに保管されます。
