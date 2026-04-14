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
- （任意）`AZURE_OPENAI_DEPLOYMENT_RAG`
- （任意）`AZURE_OPENAI_DEPLOYMENT_GPT54`
- `AZURE_SEARCH_ENDPOINT`
- `AZURE_SEARCH_API_KEY`
- `AZURE_SEARCH_INDEX`（固定インデックス）

`AZURE_OPENAI_API_VERSION` は通常空で問題ありません。

## 2. 起動 (Azure Functions)

```powershell
npm install
npm run start
```

起動後:

- Health: `GET http://localhost:7071/api/health`
- Search: `POST http://localhost:7071/api/rag/search`

## 3. リクエスト / レスポンス

Request:

```json
{
  "query": "有給休暇の繰越条件を教えて",
  "mode": "rag",
  "topK": 5
}
```

インデックスは `AZURE_SEARCH_INDEX` を使用します（固定運用）。

- `mode: "rag"`: 社内RAG（検索 + 回答）
- `mode: "gpt54"`: GPT-5.4（検索なし）

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
    "mode": "rag",
    "model": "your-deployment-name",
    "indexName": "...",
    "topK": 5,
    "retrieved": 5
  }
}
```
