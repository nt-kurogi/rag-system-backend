# RAG Backend (Azure OpenAI Responses API + Azure AI Search)

## 1. セットアップ

```powershell
copy .env.example .env
npm install
```

`.env` の以下を設定してください。

- `ENTRA_AUTH_ENABLED=true`
- `ENTRA_TENANT_ID`
- `ENTRA_CLIENT_ID`（フロント `VITE_ENTRA_CLIENT_ID` と同じ値）
- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_DEPLOYMENT`
- `AZURE_OPENAI_DEPLOYMENT_GPT56_SOL`（任意。既定 `gpt-5.6-sol`）
- `AZURE_OPENAI_DEPLOYMENT_GPT56_TERRA`（任意。既定 `gpt-5.6-terra`）
- `AZURE_OPENAI_DEPLOYMENT_GPT56_LUNA`（任意。既定 `gpt-5.6-luna`）
- `AZURE_OPENAI_GPT56_DEFAULT_MODEL`（既定 `auto`。通常はLuna、複雑な依頼はTerra。Solは手動選択のみ）
- `AZURE_SEARCH_ENDPOINT`
- `AZURE_SEARCH_API_KEY`
- `AZURE_SEARCH_INDEX`
- `COSMOS_DB_ENDPOINT`
- `COSMOS_DB_KEY`
- `COSMOS_DB_DATABASE`（例: `rag-chat`）
- `COSMOS_DB_CONTAINER`（例: `conversations`）
- `COSMOS_DB_AUDIT_CONTAINER`（例: `audit-logs`）
- `COSMOS_DB_USAGE_CONTAINER`（例: `usage-counters`、パーティションキー `/userId`）
- `AZURE_STORAGE_ACCOUNT_NAME`
- `AZURE_STORAGE_ACCOUNT_KEY`
- `AZURE_STORAGE_ATTACHMENT_CONTAINER`（例: `chat-attachments`）
- `ADMIN_USER_IDS`（Entra Object ID をカンマ区切り）
- `ADMIN_USER_NAMES`（メール/UPN をカンマ区切り、任意）
- `USAGE_DASHBOARD_ADMIN_USER_NAMES`（利用量管理画面を許可するメール/UPN。既定は `hamano@ntseimitsu.co.jp`）

利用制限の既定値は月間500万重み付きトークン・同時実行3件です。回数では制限しません。

- `MONTHLY_TOKEN_LIMIT_DEFAULT=5000000`（`0` は無制限）
- `CONCURRENT_REQUEST_LIMIT_DEFAULT=3`
- `USAGE_LIMIT_OVERRIDES`（Entra Object IDまたは小文字UPNごとのJSON上書き）
- `USAGE_REASONING_EFFORT_WEIGHTS`（既定 `none=1`、`low=1.1`、`medium=1.25`、`high=1.5`、`xhigh=2`）
- `CHAT_RETENTION_DAYS=365`（会話更新時からの保存期限、`0` は期限なし）

例:

```env
USAGE_LIMIT_OVERRIDES={"<entra-object-id>":{"monthlyTokenLimit":10000000,"concurrentLimit":5},"admin@example.com":{"monthlyTokenLimit":0,"concurrentLimit":10}}
```

## 2. 起動 (Azure Functions)

```powershell
npm run start
```

起動後:

- Health: `GET http://localhost:7071/api/health`
- Search: `POST http://localhost:7071/api/rag/search`
- New Chat: `POST http://localhost:7071/api/chat/new`
- Chat List: `GET http://localhost:7071/api/chat/list`
- Chat Detail: `GET http://localhost:7071/api/chat/{id}`
- Rename / Pin Chat: `PATCH http://localhost:7071/api/chat/{id}`
- Delete Chat: `DELETE http://localhost:7071/api/chat/{id}`
- Upload Attachments: `POST http://localhost:7071/api/chat/{id}/attachments`
- Send Message: `POST http://localhost:7071/api/chat/{id}/message`
- Stream Message: `POST http://localhost:7071/api/chat/{id}/message/stream`
- Generate File/Image: `POST http://localhost:7071/api/chat/{id}/artifact`
- Available Models: `GET http://localhost:7071/api/models`
- My Usage: `GET http://localhost:7071/api/usage/me`
- User Usage Dashboard: `GET http://localhost:7071/api/usage/admin?monthKey=YYYY-MM`
- Audit Role Check: `GET http://localhost:7071/api/audit/me`
- Audit Logs (Admin only): `GET http://localhost:7071/api/audit/logs`

## 3. 認証仕様

- `Authorization: Bearer <Entra ID token>` を必須化
- APIはJWTを Entra JWKS で検証
  - issuer: `https://login.microsoftonline.com/<tenant-id>/v2.0`
  - audience: `ENTRA_CLIENT_ID`
- 監査ログAPI（`/api/audit/*`）の閲覧は管理者のみ
  - `ADMIN_USER_IDS` または `ADMIN_USER_NAMES` と一致したユーザーのみ許可
- ユーザー別利用量API（`/api/usage/admin`）は `USAGE_DASHBOARD_ADMIN_USER_NAMES` と一致したユーザーのみ許可

## 4. リクエスト例

```json
{
  "query": "有給休暇の繰越条件を教えて",
  "mode": "rag",
  "topK": 5
}
```

通常チャットでは `mode` に `gpt56` を指定します。`modelId` は `auto`、またはバックエンドで設定済みの `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna` から選びます。`auto` は通常処理にLunaを使い、複数ファイル、Office/PDF生成、複雑な分析・設計などをTerraへ切り替えます。Solは自動判定の対象外で、手動指定時のみ使用します。未設定モデルをリクエストしても任意のAzureデプロイへはアクセスできません。`reasoningEffort` は `none`、`low`、`medium`、`high`、`xhigh` を指定できます。

```json
{
  "query": "添付した資料の要点をまとめて",
  "mode": "gpt56",
  "modelId": "gpt-5.6-terra",
  "reasoningEffort": "medium",
  "templateId": "document_summary",
  "webSearch": true,
  "attachmentIds": ["<attachment-id>"]
}
```

`templateId` は `default`、`meeting_minutes`、`document_summary`、`business_report`、`presentation`、`spreadsheet_analysis` を指定できます。通常GPTでは `webSearch` の既定値は `true`、社内RAGでは常に無効です。

成果物生成例（`format` は `pptx` / `docx` / `xlsx` / `pdf` / `png`）:

```json
{
  "query": "添付資料を経営会議向けのプレゼンにしてください",
  "format": "pptx",
  "templateId": "presentation",
  "webSearch": false,
  "attachmentIds": ["<attachment-id>"]
}
```

## 5. 保存とストリーミング

- ユーザーメッセージはモデル処理より先にCosmos DBへ保存されます。
- メッセージは会話ドキュメント全体の置換ではなく、Cosmos DBのPatchで追記します。
- ストリーミングAPIはSSEで `conversation`、`delta`、`done`、`error` イベントを返します。
- 添付ファイル本体は非公開Blob Containerへ保存し、会話にはメタデータだけを保存します。
- 生成したOffice/PDF/画像も同じ非公開Blob Containerへ保存し、期限付きSAS URLでダウンロードします。
- 既定値では1ファイル20MB、1リクエスト合計50MB、同時5ファイルまでです。
- PDFはページ番号、PowerPointはスライド番号、Excelはシート名とセル範囲、Wordは見出し名を回答に付けるようモデルへ指示します。
- 履歴は名前変更・ピン留め・削除・タイトル検索に対応し、保存期限切れの会話は非表示化と遅延削除を行います。新規Cosmosコンテナでは項目TTLも有効になります。

## 6. Web検索・画像生成の互換性

通常GPTのWeb検索とPNG生成はResponses APIの `web_search` / `image_generation` ツールを使います。これらを利用するAzure OpenAIリソース、APIエンドポイント、GPT-5.6デプロイでツールが提供されている必要があります。未提供の場合、チャット/RAG/Office・PDF生成は利用できますが、該当ツール呼び出しはプロバイダーエラーになります。

入力トークン計数エンドポイントが未提供の場合はローカル推定へ自動フォールバックします。最終的な利用量はResponses APIが返す実使用トークンで精算します。

月間上限は実測トークンに推論レベル別の社内係数を掛けた「重み付きトークン」で判定します。推定コストはGPT-5.6各モデルの公開API単価とResponses APIの入力・キャッシュ・出力トークンから計算する参考値で、Azure OpenAIの実請求額を保証するものではありません。
