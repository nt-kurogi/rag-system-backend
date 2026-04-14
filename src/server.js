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
  openAiDeploymentRag:
    process.env.AZURE_OPENAI_DEPLOYMENT_RAG ||
    requiredEnv('AZURE_OPENAI_DEPLOYMENT'),
  openAiDeploymentGpt54: process.env.AZURE_OPENAI_DEPLOYMENT_GPT54 || '',
  searchEndpoint: requiredEnv('AZURE_SEARCH_ENDPOINT'),
  searchApiKey: requiredEnv('AZURE_SEARCH_API_KEY'),
  defaultSearchIndex: process.env.AZURE_SEARCH_INDEX || '',
}

const MODE_RAG = 'rag'
const MODE_GPT54 = 'gpt54'

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

function buildInstructions(mode) {
  if (mode === MODE_RAG) {
    return 'You are a RAG assistant. Use only the provided context. If information is insufficient, clearly say so. Keep answer concise and include citation markers like [#1].'
  }

  return 'You are a helpful assistant. Answer in Japanese unless the user requests another language. Keep the response concise and practical.'
}

function buildModelInput(mode, query, context) {
  if (mode === MODE_RAG) {
    return `Question:\n${query}\n\nContext:\n${context || '(no context)'}`
  }

  return `Question:\n${query}`
}

function resolveDeployment(mode) {
  if (mode === MODE_GPT54) {
    return config.openAiDeploymentGpt54 || config.openAiDeploymentRag
  }

  return config.openAiDeploymentRag
}

async function generateAnswer({ query, context, mode, deployment }) {
  const url = `${config.openAiEndpoint}/openai/v1/responses`

  const body = {
    model: deployment,
    instructions: buildInstructions(mode),
    input: buildModelInput(mode, query, context),
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
    const mode = String(req.body?.mode || MODE_RAG).trim().toLowerCase()

    if (!query) {
      return res.status(400).json({ error: 'query is required.' })
    }

    if (mode !== MODE_RAG && mode !== MODE_GPT54) {
      return res.status(400).json({ error: "mode must be either 'rag' or 'gpt54'." })
    }

    let indexName = null
    let topK = null
    let citations = []
    let context = ''

    if (mode === MODE_RAG) {
      indexName = (req.body?.indexName || config.defaultSearchIndex || '').trim()
      const requestedTopK = Number(req.body?.topK || 5)
      topK = Number.isFinite(requestedTopK)
        ? Math.max(1, Math.min(20, Math.floor(requestedTopK)))
        : 5

      if (!indexName) {
        return res.status(400).json({
          error: 'indexName is required. Pass in request or set AZURE_SEARCH_INDEX.',
        })
      }

      const retrieval = await retrieveContext(query, indexName, topK)
      citations = retrieval.citations
      context = retrieval.context
    }

    const deployment = resolveDeployment(mode)
    if (!deployment) {
      return res.status(500).json({
        error:
          'OpenAI deployment is not configured. Set AZURE_OPENAI_DEPLOYMENT or AZURE_OPENAI_DEPLOYMENT_GPT54.',
      })
    }

    const answer = await generateAnswer({ query, context, mode, deployment })

    return res.json({
      answer,
      citations,
      meta: {
        query,
        mode,
        model: deployment,
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
