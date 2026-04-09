import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { AzureKeyCredential, SearchClient } from '@azure/search-documents'

const app = express()

app.use(express.json({ limit: '1mb' }))

const allowedOrigin = process.env.ALLOWED_ORIGIN || 'http://localhost:5173'
app.use(
  cors({
    origin: allowedOrigin,
  }),
)

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`)
  }
  return value
}

const config = {
  port: Number(process.env.PORT || 8787),
  backendApiKey: process.env.BACKEND_API_KEY || '',
  openAiEndpoint: requiredEnv('AZURE_OPENAI_ENDPOINT').replace(/\/$/, ''),
  openAiApiKey: requiredEnv('AZURE_OPENAI_API_KEY'),
  openAiDeployment: requiredEnv('AZURE_OPENAI_DEPLOYMENT'),
  searchEndpoint: requiredEnv('AZURE_SEARCH_ENDPOINT'),
  searchApiKey: requiredEnv('AZURE_SEARCH_API_KEY'),
  defaultSearchIndex: process.env.AZURE_SEARCH_INDEX || '',
}

const searchCredential = new AzureKeyCredential(config.searchApiKey)

function selectBestField(document, candidates) {
  for (const fieldName of candidates) {
    const value = document[fieldName]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return ''
}

function toCitation(result, fallbackId) {
  const doc = result.document || {}
  const title =
    selectBestField(doc, ['title', 'name', 'fileName', 'filename', 'source']) ||
    `Document ${fallbackId}`

  const url = selectBestField(doc, [
    'url',
    'sourceUrl',
    'source_url',
    'filepath',
    'path',
  ])

  const snippet =
    selectBestField(doc, ['content', 'chunk', 'text', 'body', 'description']) ||
    JSON.stringify(doc).slice(0, 500)

  return {
    id: String(doc.id ?? doc.key ?? fallbackId),
    title,
    url,
    snippet,
  }
}

async function retrieveContext(query, indexName, topK = 5) {
  const client = new SearchClient(
    config.searchEndpoint,
    indexName,
    searchCredential,
  )

  const results = await client.search(query, {
    top: topK,
  })

  const citations = []
  for await (const result of results.results) {
    citations.push(toCitation(result, citations.length + 1))
  }

  const context = citations
    .map((item, idx) => `[#${idx + 1}] ${item.title}\n${item.snippet}`)
    .join('\n\n')

  return { citations, context }
}

function extractResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim()
  }

  if (Array.isArray(data?.output_text)) {
    const joined = data.output_text.join('\n').trim()
    if (joined) {
      return joined
    }
  }

  if (Array.isArray(data?.output)) {
    const chunks = []
    for (const outputItem of data.output) {
      const contentItems = Array.isArray(outputItem?.content) ? outputItem.content : []
      for (const content of contentItems) {
        if (typeof content?.text === 'string' && content.text.trim()) {
          chunks.push(content.text.trim())
        }
      }
    }
    if (chunks.length > 0) {
      return chunks.join('\n')
    }
  }

  return 'No answer returned from model.'
}

async function generateAnswer(query, context) {
  const url = `${config.openAiEndpoint}/openai/v1/responses`

  const body = {
    model: config.openAiDeployment,
    instructions:
      'You are a RAG assistant. Use only the provided context. If information is insufficient, clearly say so. Keep answer concise and include citation markers like [#1].',
    input: `Question:\n${query}\n\nContext:\n${context || '(no context)'}`,
    max_output_tokens: 800,
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': config.openAiApiKey,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Azure OpenAI error (${response.status}): ${detail}`)
  }

  const data = await response.json()
  return extractResponseText(data)
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.post('/api/rag/search', async (req, res) => {
  try {
    if (config.backendApiKey) {
      const incoming = req.header('api-key') || ''
      if (incoming !== config.backendApiKey) {
        return res.status(401).json({ error: 'Unauthorized' })
      }
    }

    const query = (req.body?.query || '').trim()
    const indexName = (req.body?.indexName || config.defaultSearchIndex || '').trim()
    const requestedTopK = Number(req.body?.topK || 5)
    const topK = Number.isFinite(requestedTopK)
      ? Math.max(1, Math.min(20, Math.floor(requestedTopK)))
      : 5

    if (!query) {
      return res.status(400).json({ error: 'query is required.' })
    }

    if (!indexName) {
      return res.status(400).json({
        error: 'indexName is required. Pass in request or set AZURE_SEARCH_INDEX.',
      })
    }

    const { citations, context } = await retrieveContext(query, indexName, topK)
    const answer = await generateAnswer(query, context)

    return res.json({
      answer,
      citations,
      meta: {
        query,
        indexName,
        topK,
        retrieved: citations.length,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown server error'
    return res.status(500).json({ error: message })
  }
})

app.listen(config.port, () => {
  console.log(`RAG backend listening on http://localhost:${config.port}`)
})
