# RAG Backend (Azure OpenAI Responses API + Azure AI Search)

## 1. セットアップ

```powershell
cd backend
copy .env.example .env
npm install
```

`.env` の以下を設定してください。

- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_DEPLOYMENT`（モデル名ではなくデプロイ名）
- `AZURE_SEARCH_ENDPOINT`
- `AZURE_SEARCH_API_KEY`
- `AZURE_SEARCH_INDEX`（固定インデックス）

`AZURE_OPENAI_API_VERSION` は通常空で問題ありません。

## 2. 起動

```powershell
npm run dev
```

起動後:

- Health: `GET http://localhost:8787/api/health`
- Search: `POST http://localhost:8787/api/rag/search`

## 3. リクエスト / レスポンス

Request:

```json
{
  "query": "有給休暇の繰越条件を教えて",
  "topK": 5
}
```

インデックスは `AZURE_SEARCH_INDEX` を使用します（固定運用）。

Response:

```json
{
  "answer": "...",
  "citations": [
    {
      "id": "1",
      "title": "...",
      "url": "...",
      "snippet": "..."
    }
  ],
  "meta": {
    "query": "...",
    "indexName": "...",
    "topK": 5,
    "retrieved": 5
  }
}
```
