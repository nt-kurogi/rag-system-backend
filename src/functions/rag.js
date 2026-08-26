import "dotenv/config";
import { app } from "@azure/functions";
import { AzureKeyCredential, SearchClient } from "@azure/search-documents";
import { CosmosClient } from "@azure/cosmos";
import {
  BlobServiceClient,
  BlobSASPermissions,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from "@azure/storage-blob";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { buildArtifact } from "../lib/artifacts.js";

app.setup({ enableHttpStream: true });

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

const config = {
  backendApiKey: process.env.BACKEND_API_KEY || "",
  allowedOrigin:
    process.env.ALLOWED_ORIGIN ||
    "https://green-stone-03f1e0d00.7.azurestaticapps.net",
  entraAuthEnabled: String(process.env.ENTRA_AUTH_ENABLED || "false").toLowerCase() === "true",
  entraTenantId: process.env.ENTRA_TENANT_ID || "",
  entraClientId: process.env.ENTRA_CLIENT_ID || "",
  openAiEndpoint: requiredEnv("AZURE_OPENAI_ENDPOINT").replace(/\/$/, ""),
  openAiApiKey: requiredEnv("AZURE_OPENAI_API_KEY"),
  openAiDeploymentRag:
    process.env.AZURE_OPENAI_DEPLOYMENT_RAG ||
    requiredEnv("AZURE_OPENAI_DEPLOYMENT"),
  openAiDeploymentGpt56Sol:
    process.env.AZURE_OPENAI_DEPLOYMENT_GPT56_SOL ||
    process.env.AZURE_OPENAI_DEPLOYMENT_GPT56 ||
    "",
  openAiDeploymentGpt56Terra:
    process.env.AZURE_OPENAI_DEPLOYMENT_GPT56_TERRA || "",
  openAiDeploymentGpt56Luna:
    process.env.AZURE_OPENAI_DEPLOYMENT_GPT56_LUNA || "",
  openAiGpt56DefaultModel:
    process.env.AZURE_OPENAI_GPT56_DEFAULT_MODEL || "gpt-5.6-sol",
  openAiMaxOutputTokens: Number(
    process.env.AZURE_OPENAI_MAX_OUTPUT_TOKENS || 4000,
  ),
  openAiInputTokenCountEnabled:
    String(
      process.env.AZURE_OPENAI_INPUT_TOKEN_COUNT_ENABLED || "true",
    ).toLowerCase() === "true",
  searchEndpoint: requiredEnv("AZURE_SEARCH_ENDPOINT"),
  searchApiKey: requiredEnv("AZURE_SEARCH_API_KEY"),
  defaultSearchIndex: process.env.AZURE_SEARCH_INDEX || "",
  storageAccountName: process.env.AZURE_STORAGE_ACCOUNT_NAME || "",
  storageAccountKey: process.env.AZURE_STORAGE_ACCOUNT_KEY || "",
  blobSasExpiryMinutes: Number(process.env.BLOB_SAS_EXPIRY_MINUTES || 30),
  attachmentContainerName:
    process.env.AZURE_STORAGE_ATTACHMENT_CONTAINER || "chat-attachments",
  attachmentMaxFileBytes: Number(
    process.env.ATTACHMENT_MAX_FILE_BYTES || 20 * 1024 * 1024,
  ),
  attachmentMaxRequestBytes: Number(
    process.env.ATTACHMENT_MAX_REQUEST_BYTES || 50 * 1024 * 1024,
  ),
  attachmentMaxFiles: Number(process.env.ATTACHMENT_MAX_FILES || 5),
  chatHistoryMaxMessages: Number(process.env.CHAT_HISTORY_MAX_MESSAGES || 20),
  chatRetentionDays: Number(process.env.CHAT_RETENTION_DAYS || 365),
  cosmosEndpoint: process.env.COSMOS_DB_ENDPOINT || "",
  cosmosKey: process.env.COSMOS_DB_KEY || "",
  cosmosDatabaseName: process.env.COSMOS_DB_DATABASE || "rag-chat",
  cosmosContainerName: process.env.COSMOS_DB_CONTAINER || "conversations",
  cosmosAuditContainerName: process.env.COSMOS_DB_AUDIT_CONTAINER || "audit-logs",
  cosmosUsageContainerName:
    process.env.COSMOS_DB_USAGE_CONTAINER || "usage-counters",
  monthlyTokenLimitDefault: Number(
    process.env.MONTHLY_TOKEN_LIMIT_DEFAULT || 5_000_000,
  ),
  concurrentRequestLimitDefault: Number(
    process.env.CONCURRENT_REQUEST_LIMIT_DEFAULT || 3,
  ),
  usageLimitOverrides: parseJsonObject(process.env.USAGE_LIMIT_OVERRIDES || ""),
  usageTimeZoneOffsetMinutes: Number(
    process.env.USAGE_TIMEZONE_OFFSET_MINUTES || 540,
  ),
  usageLeaseTimeoutSeconds: Number(
    process.env.USAGE_LEASE_TIMEOUT_SECONDS || 900,
  ),
  usageReasoningEffortWeights: {
    none: 1,
    low: 1.1,
    medium: 1.25,
    high: 1.5,
    xhigh: 2,
    ...parseJsonObject(process.env.USAGE_REASONING_EFFORT_WEIGHTS || ""),
  },
  imageGenerationEnabled:
    String(process.env.IMAGE_GENERATION_ENABLED || "true").toLowerCase() ===
    "true",
  adminUserIds: String(process.env.ADMIN_USER_IDS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean),
  adminUserNames: String(process.env.ADMIN_USER_NAMES || "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean),
  usageDashboardAdminUserNames: String(
    process.env.USAGE_DASHBOARD_ADMIN_USER_NAMES ||
      "hamano@ntseimitsu.co.jp",
  )
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean),
};

function buildEntraIssuer(tenantId) {
  return `https://login.microsoftonline.com/${tenantId}/v2.0`;
}

function parseJsonObject(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function buildEntraJwksUri(tenantId) {
  return `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`;
}

let entraJwks = null;
function getEntraJwks() {
  if (!entraJwks) {
    entraJwks = createRemoteJWKSet(new URL(buildEntraJwksUri(config.entraTenantId)));
  }
  return entraJwks;
}

const MODE_RAG = "rag";
const MODE_GPT56 = "gpt56";
const LEGACY_MODE_GPT54 = "gpt54";
const ARTIFACT_FORMATS = new Set(["pptx", "docx", "xlsx", "pdf", "png"]);

const PROMPT_TEMPLATES = {
  default: "",
  meeting_minutes:
    "会議内容を、目的・参加者・決定事項・未決事項・担当者付きアクション・期限に整理してください。情報がない項目は推測しないでください。",
  document_summary:
    "資料を、概要・重要ポイント・数値・リスク・次に確認すべき事項に分けて要約してください。",
  business_report:
    "社内報告書として、背景・現状・分析・課題・提案・次のアクションの順に整理してください。",
  presentation:
    "プレゼン資料向けに、結論を先に示し、各セクションを1つの主張と根拠に整理してください。",
  spreadsheet_analysis:
    "表計算資料を分析し、対象シート・セル範囲・主要数値・傾向・外れ値・判断材料を明記してください。",
};

const ARTIFACT_SPEC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "subtitle", "summary", "sections", "worksheets"],
  properties: {
    title: { type: "string" },
    subtitle: { type: "string" },
    summary: { type: "string" },
    sections: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "paragraphs", "bullets", "table"],
        properties: {
          title: { type: "string" },
          paragraphs: { type: "array", items: { type: "string" } },
          bullets: { type: "array", items: { type: "string" } },
          table: {
            type: "object",
            additionalProperties: false,
            required: ["headers", "rows"],
            properties: {
              headers: { type: "array", items: { type: "string" } },
              rows: {
                type: "array",
                items: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
    },
    worksheets: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "rows"],
        properties: {
          name: { type: "string" },
          rows: {
            type: "array",
            items: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
};

const GPT56_REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
];
const REASONING_EFFORTS = new Set(GPT56_REASONING_EFFORTS);

// OpenAI public API list pricing as of 2026-08-26. Azure billing can differ.
const MODEL_PRICING_USD_PER_MILLION_TOKENS = {
  "gpt-5.6-sol": {
    input: 4,
    cachedInput: 0.4,
    cacheWriteInput: 5,
    output: 20,
  },
  "gpt-5.6-terra": {
    input: 2,
    cachedInput: 0.2,
    cacheWriteInput: 2.5,
    output: 12,
  },
  "gpt-5.6-luna": {
    input: 0.2,
    cachedInput: 0.02,
    cacheWriteInput: 0.25,
    output: 1.2,
  },
};

function getConfiguredGpt56Models() {
  return [
    {
      id: "gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      description: "複雑な推論や高品質な業務向け",
      deployment: config.openAiDeploymentGpt56Sol,
    },
    {
      id: "gpt-5.6-terra",
      label: "GPT-5.6 Terra",
      description: "性能とコストのバランス向け",
      deployment: config.openAiDeploymentGpt56Terra,
    },
    {
      id: "gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      description: "高速・高頻度・低コスト処理向け",
      deployment: config.openAiDeploymentGpt56Luna,
    },
  ]
    .filter((item) => !!item.deployment)
    .map((item) => ({
      ...item,
      reasoningEfforts: GPT56_REASONING_EFFORTS,
      defaultReasoningEffort: "medium",
    }));
}

function getDefaultGpt56Model(models = getConfiguredGpt56Models()) {
  const configuredDefault = normalizeGpt56ModelId(
    config.openAiGpt56DefaultModel,
  );
  return (
    models.find((item) => item.id === configuredDefault) ||
    models[0] ||
    null
  );
}

function toClientModel(model) {
  if (!model) return null;
  return {
    id: model.id,
    label: model.label,
    description: model.description,
    reasoningEfforts: model.reasoningEfforts,
    defaultReasoningEffort: model.defaultReasoningEffort,
  };
}

const ATTACHMENT_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
  ".csv",
  ".txt",
  ".md",
  ".json",
  ".xml",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
]);

const searchCredential = new AzureKeyCredential(config.searchApiKey);

function getCorsHeaders(req) {
  const origin = req.headers.get("origin") || "";
  const allowOrigin =
    config.allowedOrigin === "*" || origin === config.allowedOrigin
      ? origin || config.allowedOrigin
      : config.allowedOrigin;

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,api-key,Authorization",
  };
}

async function verifyEntraAuthorization(req) {
  if (!config.entraAuthEnabled) {
    return {
      ok: true,
      principal: {
        userId: "anonymous",
        userName: "anonymous",
        claims: {},
      },
    };
  }

  if (!config.entraTenantId || !config.entraClientId) {
    return { ok: false, message: "ENTRA_TENANT_ID / ENTRA_CLIENT_ID is required when ENTRA_AUTH_ENABLED=true." };
  }

  const auth = req.headers.get("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return { ok: false, message: "Missing bearer token." };
  }

  try {
    const verified = await jwtVerify(match[1], getEntraJwks(), {
      issuer: buildEntraIssuer(config.entraTenantId),
      audience: config.entraClientId,
    });
    const claims = verified.payload || {};
    const userId = String(
      claims.oid || claims.sub || claims.preferred_username || "unknown-user",
    );
    const userName = String(
      claims.preferred_username ||
        claims.upn ||
        claims.email ||
        claims.name ||
        userId,
    );
    return {
      ok: true,
      principal: {
        userId,
        userName,
        claims,
      },
    };
  } catch (e) {
    const detail = e instanceof Error ? e.message : "Invalid token";
    return { ok: false, message: `Invalid Entra token: ${detail}` };
  }
}

function jsonResponse(req, status, body) {
  return {
    status,
    jsonBody: body,
    headers: getCorsHeaders(req),
  };
}

function validateApiKey(req) {
  if (!config.backendApiKey) {
    return { ok: true };
  }
  const incoming = req.headers.get("api-key") || "";
  if (incoming !== config.backendApiKey) {
    return { ok: false, message: "Unauthorized" };
  }
  return { ok: true };
}

async function getAuthContext(req) {
  const authCheck = await verifyEntraAuthorization(req);
  if (!authCheck.ok) {
    return authCheck;
  }

  const apiCheck = validateApiKey(req);
  if (!apiCheck.ok) {
    return apiCheck;
  }

  return { ok: true, principal: authCheck.principal };
}

let cosmosContainerPromise = null;
async function getConversationContainer() {
  if (cosmosContainerPromise) {
    return cosmosContainerPromise;
  }

  cosmosContainerPromise = (async () => {
    const endpoint = requiredEnv("COSMOS_DB_ENDPOINT");
    const key = requiredEnv("COSMOS_DB_KEY");
    const client = new CosmosClient({ endpoint, key });

    const { database } = await client.databases.createIfNotExists({
      id: config.cosmosDatabaseName,
    });
    const { container } = await database.containers.createIfNotExists({
      id: config.cosmosContainerName,
      partitionKey: { paths: ["/userId"] },
      defaultTtl: -1,
    });
    return container;
  })();

  return cosmosContainerPromise;
}

let cosmosAuditContainerPromise = null;
async function getAuditContainer() {
  if (cosmosAuditContainerPromise) {
    return cosmosAuditContainerPromise;
  }

  cosmosAuditContainerPromise = (async () => {
    const endpoint = requiredEnv("COSMOS_DB_ENDPOINT");
    const key = requiredEnv("COSMOS_DB_KEY");
    const client = new CosmosClient({ endpoint, key });

    const { database } = await client.databases.createIfNotExists({
      id: config.cosmosDatabaseName,
    });
    const { container } = await database.containers.createIfNotExists({
      id: config.cosmosAuditContainerName,
      partitionKey: { paths: ["/dateKey"] },
    });
    return container;
  })();

  return cosmosAuditContainerPromise;
}

let cosmosUsageContainerPromise = null;
async function getUsageContainer() {
  if (cosmosUsageContainerPromise) {
    return cosmosUsageContainerPromise;
  }

  cosmosUsageContainerPromise = (async () => {
    const endpoint = requiredEnv("COSMOS_DB_ENDPOINT");
    const key = requiredEnv("COSMOS_DB_KEY");
    const client = new CosmosClient({ endpoint, key });
    const { database } = await client.databases.createIfNotExists({
      id: config.cosmosDatabaseName,
    });
    const { container } = await database.containers.createIfNotExists({
      id: config.cosmosUsageContainerName,
      partitionKey: { paths: ["/userId"] },
    });
    return container;
  })();

  return cosmosUsageContainerPromise;
}

let attachmentContainerPromise = null;
async function getAttachmentContainer() {
  if (attachmentContainerPromise) {
    return attachmentContainerPromise;
  }

  attachmentContainerPromise = (async () => {
    if (!config.storageAccountName || !config.storageAccountKey) {
      throw new Error(
        "Attachment storage is not configured. Set AZURE_STORAGE_ACCOUNT_NAME and AZURE_STORAGE_ACCOUNT_KEY.",
      );
    }

    const credential = new StorageSharedKeyCredential(
      config.storageAccountName,
      config.storageAccountKey,
    );
    const service = new BlobServiceClient(
      `https://${config.storageAccountName}.blob.core.windows.net`,
      credential,
    );
    const container = service.getContainerClient(config.attachmentContainerName);
    await container.createIfNotExists();
    return container;
  })();

  return attachmentContainerPromise;
}

async function writeAuditLog({
  req,
  principal,
  action,
  statusCode,
  latencyMs,
  errorMessage = "",
  details = {},
}) {
  try {
    const container = await getAuditContainer();
    const createdAt = nowIso();
    const item = {
      id: randomUUID(),
      dateKey: toDateKey(createdAt),
      createdAt,
      action: String(action || "unknown"),
      method: req.method,
      path: getPathname(req),
      statusCode: Number(statusCode || 0),
      success: Number(statusCode || 0) >= 200 && Number(statusCode || 0) < 400,
      latencyMs: Number(latencyMs || 0),
      userId: String(principal?.userId || "anonymous"),
      userName: String(principal?.userName || "anonymous"),
      ip: getClientIp(req),
      userAgent: req.headers.get("user-agent") || "",
      errorMessage: String(errorMessage || ""),
      details: details && typeof details === "object" ? details : {},
    };
    await container.items.create(item);
  } catch {
    // Do not break app flow if audit log write fails.
  }
}

function nowIso() {
  return new Date().toISOString();
}

function toDateKey(iso) {
  return String(iso || "").slice(0, 10);
}

function getUsagePeriod(now = new Date()) {
  const offsetMs = config.usageTimeZoneOffsetMinutes * 60 * 1000;
  const shifted = new Date(now.getTime() + offsetMs);
  const year = shifted.getUTCFullYear();
  const monthIndex = shifted.getUTCMonth();
  const monthKey = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
  const resetAt = new Date(
    Date.UTC(year, monthIndex + 1, 1) - offsetMs,
  ).toISOString();
  return { monthKey, resetAt };
}

function getUsagePolicy(principal) {
  const userId = String(principal?.userId || "anonymous");
  const userName = String(principal?.userName || "").toLowerCase();
  const override =
    config.usageLimitOverrides[userId] ||
    config.usageLimitOverrides[userName] ||
    {};
  const overrideObject =
    typeof override === "number" ? { monthlyTokenLimit: override } : override;
  const rawMonthlyLimit = Number(
    overrideObject?.monthlyTokenLimit ?? config.monthlyTokenLimitDefault,
  );
  const rawConcurrentLimit = Number(
    overrideObject?.concurrentLimit ?? config.concurrentRequestLimitDefault,
  );
  const unlimited = Number.isFinite(rawMonthlyLimit) && rawMonthlyLimit <= 0;
  return {
    monthlyTokenLimit: unlimited
      ? Number.MAX_SAFE_INTEGER
      : Math.max(10_000, Math.floor(rawMonthlyLimit || 5_000_000)),
    concurrentLimit: Math.max(
      1,
      Math.min(20, Math.floor(rawConcurrentLimit || 3)),
    ),
    unlimited,
  };
}

function makeUsageDocument(principal, period) {
  const now = nowIso();
  return {
    id: period.monthKey,
    userId: String(principal.userId),
    userName: String(principal.userName || principal.userId),
    monthKey: period.monthKey,
    resetAt: period.resetAt,
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    weightedTokenAdjustment: 0,
    estimatedCostNanoUsd: 0,
    pricedTokens: 0,
    accountingVersion: 2,
    reservedTokens: 0,
    activeRequests: 0,
    activeUpdatedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

async function ensureUsageAccountingFields(doc, item) {
  const operations = [];
  if (!Number.isFinite(Number(doc?.weightedTokenAdjustment))) {
    operations.push({ op: "set", path: "/weightedTokenAdjustment", value: 0 });
  }
  if (!Number.isFinite(Number(doc?.estimatedCostNanoUsd))) {
    operations.push({ op: "set", path: "/estimatedCostNanoUsd", value: 0 });
  }
  if (!Number.isFinite(Number(doc?.pricedTokens))) {
    operations.push({ op: "set", path: "/pricedTokens", value: 0 });
  }
  if (Number(doc?.accountingVersion || 0) < 2) {
    operations.push({ op: "set", path: "/accountingVersion", value: 2 });
  }
  if (operations.length === 0) return doc;
  const { resource } = await item.patch(operations);
  return resource || { ...doc, weightedTokenAdjustment: 0 };
}

async function getOrCreateUsageDocument(principal) {
  const container = await getUsageContainer();
  const period = getUsagePeriod();
  const item = container.item(period.monthKey, principal.userId);
  try {
    const { resource } = await item.read();
    if (resource) return ensureUsageAccountingFields(resource, item);
  } catch (error) {
    if (Number(error?.code || error?.statusCode) !== 404) throw error;
  }

  const created = makeUsageDocument(principal, period);
  try {
    const { resource } = await container.items.create(created);
    return resource || created;
  } catch (error) {
    if (Number(error?.code || error?.statusCode) !== 409) throw error;
    const { resource } = await item.read();
    return ensureUsageAccountingFields(resource, item);
  }
}

async function clearStaleUsageLeaseIfNeeded(doc) {
  const activeRequests = Number(doc?.activeRequests || 0);
  if (activeRequests <= 0) return doc;
  const activeAt = Date.parse(doc.activeUpdatedAt || "");
  const timeoutMs = Math.max(60, config.usageLeaseTimeoutSeconds) * 1000;
  if (Number.isFinite(activeAt) && Date.now() - activeAt <= timeoutMs) return doc;

  const container = await getUsageContainer();
  const { resource } = await container.item(doc.id, doc.userId).patch([
    { op: "set", path: "/activeRequests", value: 0 },
    { op: "set", path: "/reservedTokens", value: 0 },
    { op: "set", path: "/activeUpdatedAt", value: nowIso() },
    { op: "set", path: "/updatedAt", value: nowIso() },
  ]);
  return resource || { ...doc, activeRequests: 0, reservedTokens: 0 };
}

function toClientUsage(doc, policy) {
  const rawTokens = Math.max(0, Number(doc?.totalTokens || 0));
  const weightedTokenAdjustment = Number(doc?.weightedTokenAdjustment || 0);
  const usedTokens = Math.max(0, rawTokens + weightedTokenAdjustment);
  const reservedTokens = Math.max(0, Number(doc?.reservedTokens || 0));
  const limit = policy.unlimited ? null : policy.monthlyTokenLimit;
  const percentage = limit
    ? Math.min(100, Math.round((usedTokens / limit) * 10_000) / 100)
    : 0;
  return {
    monthKey: doc?.monthKey || getUsagePeriod().monthKey,
    resetAt: doc?.resetAt || getUsagePeriod().resetAt,
    requestCount: Math.max(0, Number(doc?.requestCount || 0)),
    inputTokens: Math.max(0, Number(doc?.inputTokens || 0)),
    outputTokens: Math.max(0, Number(doc?.outputTokens || 0)),
    cachedTokens: Math.max(0, Number(doc?.cachedTokens || 0)),
    reasoningTokens: Math.max(0, Number(doc?.reasoningTokens || 0)),
    rawTokens,
    weightedTokens: usedTokens,
    usedTokens,
    reservedTokens,
    remainingTokens: limit ? Math.max(0, limit - usedTokens - reservedTokens) : null,
    monthlyTokenLimit: limit,
    percentage,
    unlimited: policy.unlimited,
    activeRequests: Math.max(0, Number(doc?.activeRequests || 0)),
    concurrentLimit: policy.concurrentLimit,
    estimatedCostUsd:
      Math.max(0, Number(doc?.estimatedCostNanoUsd || 0)) / 1_000_000_000,
  };
}

async function getUsageSnapshot(principal) {
  const policy = getUsagePolicy(principal);
  let doc = await getOrCreateUsageDocument(principal);
  doc = await clearStaleUsageLeaseIfNeeded(doc);
  return { doc, policy, usage: toClientUsage(doc, policy) };
}

async function reserveUsage(
  principal,
  { inputTokens, maxOutputTokens, modelId = "", reasoningEffort = "" },
) {
  const snapshot = await getUsageSnapshot(principal);
  const rawReservationTokens = Math.max(
    1,
    Math.floor(Number(inputTokens || 0) + Number(maxOutputTokens || 0)),
  );
  const effortWeight = getReasoningEffortWeight(reasoningEffort);
  const reservationTokens = Math.max(
    1,
    Math.ceil(rawReservationTokens * effortWeight),
  );
  const { doc, policy } = snapshot;
  const used =
    Number(doc.totalTokens || 0) +
    Number(doc.weightedTokenAdjustment || 0) +
    Number(doc.reservedTokens || 0);
  if (!policy.unlimited && used + reservationTokens > policy.monthlyTokenLimit) {
    return { ok: false, reason: "monthly_token_limit", ...snapshot };
  }
  if (Number(doc.activeRequests || 0) >= policy.concurrentLimit) {
    return { ok: false, reason: "concurrent_limit", ...snapshot };
  }

  const tokenClause = policy.unlimited
    ? "true"
    : `c.totalTokens + c.weightedTokenAdjustment + c.reservedTokens + ${reservationTokens} <= ${policy.monthlyTokenLimit}`;
  const filterPredicate = `FROM c WHERE ${tokenClause} AND c.activeRequests < ${policy.concurrentLimit}`;
  const container = await getUsageContainer();
  try {
    const { resource } = await container.item(doc.id, doc.userId).patch({
      operations: [
        { op: "incr", path: "/reservedTokens", value: reservationTokens },
        { op: "incr", path: "/activeRequests", value: 1 },
        { op: "incr", path: "/requestCount", value: 1 },
        { op: "set", path: "/activeUpdatedAt", value: nowIso() },
        { op: "set", path: "/updatedAt", value: nowIso() },
      ],
      condition: filterPredicate,
    });
    return {
      ok: true,
      id: doc.id,
      userId: doc.userId,
      reservationTokens,
      rawReservationTokens,
      estimatedInputTokens: Math.max(0, Number(inputTokens || 0)),
      modelId: normalizeGpt56ModelId(modelId),
      reasoningEffort: normalizeUsageReasoningEffort(reasoningEffort),
      effortWeight,
      policy,
      usage: toClientUsage(resource || doc, policy),
    };
  } catch (error) {
    const current = await getUsageSnapshot(principal);
    const blockedByConcurrency =
      current.usage.activeRequests >= current.policy.concurrentLimit;
    const blockedByTokens =
      !current.policy.unlimited &&
      Number(current.usage.remainingTokens || 0) < reservationTokens;
    if (blockedByConcurrency || blockedByTokens) {
      return {
        ok: false,
        reason: blockedByConcurrency ? "concurrent_limit" : "monthly_token_limit",
        ...current,
      };
    }
    throw error;
  }
}

function normalizeResponseUsage(value, fallbackTotal = 0) {
  const inputTokens = Math.max(0, Number(value?.input_tokens || 0));
  const outputTokens = Math.max(0, Number(value?.output_tokens || 0));
  const totalTokens = Math.max(
    0,
    Number(value?.total_tokens || inputTokens + outputTokens || fallbackTotal),
  );
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedTokens: Math.max(
      0,
      Number(value?.input_tokens_details?.cached_tokens || 0),
    ),
    cacheWriteTokens: Math.max(
      0,
      Number(value?.input_tokens_details?.cache_write_tokens || 0),
    ),
    reasoningTokens: Math.max(
      0,
      Number(value?.output_tokens_details?.reasoning_tokens || 0),
    ),
  };
}

function makeLeaseFallbackUsage(lease) {
  const totalTokens = Math.max(0, Number(lease?.rawReservationTokens || 0));
  const inputTokens = Math.min(
    totalTokens,
    Math.max(0, Number(lease?.estimatedInputTokens || 0)),
  );
  return {
    inputTokens,
    outputTokens: Math.max(0, totalTokens - inputTokens),
    totalTokens,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
}

function normalizeUsageReasoningEffort(value) {
  const effort = String(value || "").trim().toLowerCase();
  return REASONING_EFFORTS.has(effort) ? effort : "unknown";
}

function getReasoningEffortWeight(value) {
  const effort = normalizeUsageReasoningEffort(value);
  if (effort === "unknown") return 1;
  const configured = Number(config.usageReasoningEffortWeights[effort]);
  return Number.isFinite(configured)
    ? Math.max(1, Math.min(10, configured))
    : 1;
}

function getUsageModelKey(value) {
  const modelId = normalizeGpt56ModelId(value);
  if (modelId === "gpt-5.6-sol") return "Sol";
  if (modelId === "gpt-5.6-terra") return "Terra";
  if (modelId === "gpt-5.6-luna") return "Luna";
  if (modelId === "rag") return "Rag";
  return "Unknown";
}

function calculateUsageAccounting(value, { modelId = "", reasoningEffort = "" } = {}) {
  const usage = value && "totalTokens" in value ? value : normalizeResponseUsage(value);
  const effort = normalizeUsageReasoningEffort(reasoningEffort);
  const effortWeight = getReasoningEffortWeight(effort);
  const weightedTokens = Math.max(0, Math.ceil(usage.totalTokens * effortWeight));
  const normalizedModelId = normalizeGpt56ModelId(modelId);
  const pricing = MODEL_PRICING_USD_PER_MILLION_TOKENS[normalizedModelId] || null;

  let estimatedCostNanoUsd = 0;
  if (pricing) {
    const cachedTokens = Math.min(usage.inputTokens, usage.cachedTokens);
    const cacheWriteTokens = Math.min(
      Math.max(0, usage.inputTokens - cachedTokens),
      usage.cacheWriteTokens,
    );
    const uncachedInputTokens = Math.max(
      0,
      usage.inputTokens - cachedTokens - cacheWriteTokens,
    );
    const longContextInputMultiplier = usage.inputTokens > 272_000 ? 2 : 1;
    const longContextOutputMultiplier = usage.inputTokens > 272_000 ? 1.5 : 1;
    estimatedCostNanoUsd = Math.round(
      (uncachedInputTokens * pricing.input * 1_000 +
        cachedTokens * pricing.cachedInput * 1_000 +
        cacheWriteTokens * pricing.cacheWriteInput * 1_000) *
        longContextInputMultiplier +
        usage.outputTokens *
          pricing.output *
          1_000 *
          longContextOutputMultiplier,
    );
  }

  return {
    ...usage,
    modelId: normalizedModelId || "unknown",
    reasoningEffort: effort,
    effortWeight,
    weightedTokens,
    estimatedCostNanoUsd,
    estimatedCostUsd: estimatedCostNanoUsd / 1_000_000_000,
  };
}

async function settleUsage(lease, responseUsage, { chargeUnknown = false } = {}) {
  if (!lease?.ok) return null;
  const normalized = responseUsage
    ? normalizeResponseUsage(responseUsage)
    : chargeUnknown
      ? makeLeaseFallbackUsage(lease)
      : normalizeResponseUsage(null);
  const accounting = calculateUsageAccounting(normalized, {
    modelId: lease.modelId,
    reasoningEffort: lease.reasoningEffort,
  });
  const effortField =
    accounting.reasoningEffort === "unknown"
      ? "Unknown"
      : `${accounting.reasoningEffort[0].toUpperCase()}${accounting.reasoningEffort.slice(1)}`;
  const modelField = getUsageModelKey(accounting.modelId);
  const completedRequestIncrement = accounting.totalTokens > 0 ? 1 : 0;
  const container = await getUsageContainer();
  const coreOperations = [
    { op: "incr", path: "/reservedTokens", value: -lease.reservationTokens },
    { op: "incr", path: "/activeRequests", value: -1 },
    { op: "incr", path: "/inputTokens", value: normalized.inputTokens },
    { op: "incr", path: "/outputTokens", value: normalized.outputTokens },
    { op: "incr", path: "/cachedTokens", value: normalized.cachedTokens },
    { op: "incr", path: "/reasoningTokens", value: normalized.reasoningTokens },
    { op: "incr", path: "/totalTokens", value: normalized.totalTokens },
    {
      op: "incr",
      path: "/weightedTokenAdjustment",
      value: accounting.weightedTokens - accounting.totalTokens,
    },
    {
      op: "incr",
      path: "/estimatedCostNanoUsd",
      value: accounting.estimatedCostNanoUsd,
    },
    { op: "set", path: "/activeUpdatedAt", value: nowIso() },
  ];
  const analyticsOperations = [
    {
      op: "incr",
      path: `/effort${effortField}Requests`,
      value: completedRequestIncrement,
    },
    {
      op: "incr",
      path: `/effort${effortField}Tokens`,
      value: accounting.totalTokens,
    },
    {
      op: "incr",
      path: `/effort${effortField}WeightedTokens`,
      value: accounting.weightedTokens,
    },
    {
      op: "incr",
      path: `/model${modelField}Requests`,
      value: completedRequestIncrement,
    },
    {
      op: "incr",
      path: `/model${modelField}Tokens`,
      value: accounting.totalTokens,
    },
    {
      op: "incr",
      path: `/model${modelField}CostNanoUsd`,
      value: accounting.estimatedCostNanoUsd,
    },
    {
      op: "incr",
      path: "/pricedTokens",
      value: MODEL_PRICING_USD_PER_MILLION_TOKENS[accounting.modelId]
        ? accounting.totalTokens
        : 0,
    },
    { op: "set", path: "/accountingVersion", value: 2 },
    { op: "set", path: "/updatedAt", value: nowIso() },
  ];
  const { resource: coreResource } = await container
    .item(lease.id, lease.userId)
    .patch(coreOperations);
  let resource = coreResource;
  try {
    const analyticsResult = await container
      .item(lease.id, lease.userId)
      .patch(analyticsOperations);
    resource = analyticsResult.resource || resource;
  } catch {
    // Quota settlement is authoritative; analytics breakdown is best effort.
  }
  return toClientUsage(resource, lease.policy);
}

async function releaseUsage(lease) {
  return settleUsage(lease, null, { chargeUnknown: false });
}

function makeUsageLimitResult(reservation) {
  const concurrency = reservation?.reason === "concurrent_limit";
  return {
    ok: false,
    status: 429,
    code: concurrency ? "concurrent_limit" : "monthly_token_limit",
    error: concurrency
      ? "同時に実行できる処理数の上限に達しています。完了後に再試行してください。"
      : "今月のトークン上限に達しました。翌月のリセット後に再試行してください。",
    usage: reservation?.usage || null,
  };
}

function getClientIp(req) {
  const xff = req.headers.get("x-forwarded-for") || "";
  if (xff) {
    return xff.split(",")[0].trim();
  }
  return req.headers.get("x-client-ip") || "";
}

function getPathname(req) {
  try {
    return new URL(req.url).pathname || "";
  } catch {
    return "";
  }
}

function isAdminPrincipal(principal) {
  if (!principal) {
    return false;
  }
  if (config.adminUserIds.includes(String(principal.userId || ""))) {
    return true;
  }
  const name = String(principal.userName || "").toLowerCase();
  return !!name && config.adminUserNames.includes(name);
}

function isUsageDashboardAdminPrincipal(principal) {
  if (!principal) return false;
  const claims = principal.claims || {};
  const candidates = [
    claims.preferred_username,
    claims.upn,
    claims.email,
    principal.userName,
  ]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  return candidates.some((name) =>
    config.usageDashboardAdminUserNames.includes(name),
  );
}

function makeConversationTitle(input) {
  const text = String(input || "").trim().replace(/\s+/g, " ");
  if (!text) {
    return "新しいチャット";
  }
  return text.slice(0, 40);
}

function getConversationExpiresAt(from = new Date()) {
  const days = Math.floor(config.chatRetentionDays || 0);
  if (days <= 0) return null;
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function resolveConversationExpiresAt(conversation) {
  if (conversation?.expiresAt) return conversation.expiresAt;
  if (!conversation?.updatedAt) return null;
  const updatedAt = new Date(conversation.updatedAt);
  if (Number.isNaN(updatedAt.getTime())) return null;
  return getConversationExpiresAt(updatedAt);
}

function isConversationExpired(conversation) {
  const rawExpiresAt = resolveConversationExpiresAt(conversation);
  if (!rawExpiresAt) return false;
  const expiresAt = Date.parse(rawExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function conversationLifecycleOperations(updatedAt = nowIso()) {
  const operations = [{ op: "set", path: "/updatedAt", value: updatedAt }];
  const expiresAt = getConversationExpiresAt(new Date(updatedAt));
  if (expiresAt) {
    operations.push({ op: "set", path: "/expiresAt", value: expiresAt });
    operations.push({
      op: "set",
      path: "/ttl",
      value: Math.max(1, Math.floor(config.chatRetentionDays * 24 * 60 * 60)),
    });
  } else {
    operations.push({ op: "set", path: "/expiresAt", value: null });
    operations.push({ op: "set", path: "/ttl", value: -1 });
  }
  return operations;
}

function summarizeConversation(doc) {
  const messages = Array.isArray(doc.messages) ? doc.messages : [];
  const last = messages.length > 0 ? messages[messages.length - 1] : null;
  return {
    id: doc.id,
    title: doc.title || "新しいチャット",
    createdAt: doc.createdAt || "",
    updatedAt: doc.updatedAt || "",
    messageCount: messages.length,
    lastMessagePreview: last?.content ? String(last.content).slice(0, 80) : "",
    attachmentCount: Array.isArray(doc.attachments) ? doc.attachments.length : 0,
    pinned: !!doc.pinned,
    expiresAt: resolveConversationExpiresAt(doc),
  };
}

async function createConversation(userId, title = "") {
  const container = await getConversationContainer();
  const now = nowIso();
  const item = {
    id: randomUUID(),
    userId,
    title: makeConversationTitle(title),
    createdAt: now,
    updatedAt: now,
    messages: [],
    attachments: [],
    pinned: false,
    expiresAt: getConversationExpiresAt(new Date(now)),
    ttl:
      config.chatRetentionDays > 0
        ? Math.max(1, Math.floor(config.chatRetentionDays * 24 * 60 * 60))
        : -1,
  };
  await container.items.create(item);
  return item;
}

async function getConversation(userId, conversationId) {
  const container = await getConversationContainer();
  const { resource } = await container.item(conversationId, userId).read();
  if (!resource) return null;
  if (!isConversationExpired(resource)) return resource;
  try {
    await deleteConversationData(resource);
  } catch {
    // The expired conversation remains inaccessible even if cleanup is retried later.
  }
  return null;
}

async function listConversations(userId, { query = "" } = {}) {
  const container = await getConversationContainer();
  const normalizedQuery = String(query || "").trim().toLowerCase();
  const querySpec = {
    query:
      `SELECT c.id, c.userId, c.title, c.createdAt, c.updatedAt, c.messages, c.attachments, c.pinned, c.expiresAt ` +
      "FROM c WHERE c.userId = @userId ORDER BY c.updatedAt DESC",
    parameters: [{ name: "@userId", value: userId }],
  };
  const { resources } = await container.items.query(querySpec).fetchAll();
  const expired = (resources || []).filter((item) => isConversationExpired(item));
  if (expired.length > 0) {
    await Promise.allSettled(expired.map((item) => deleteConversationData(item)));
  }
  return (resources || [])
    .filter((item) => !isConversationExpired(item))
    .filter(
      (item) =>
        !normalizedQuery ||
        String(item.title || "").toLowerCase().includes(normalizedQuery),
    )
    .map((item) => summarizeConversation(item))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned));
}

async function appendConversationMessage(conversation, message, { updateTitle = false } = {}) {
  const container = await getConversationContainer();
  const updatedAt = nowIso();
  const operations = [
    { op: "add", path: "/messages/-", value: message },
    ...conversationLifecycleOperations(updatedAt),
  ];
  if (updateTitle) {
    operations.push({
      op: "set",
      path: "/title",
      value: makeConversationTitle(message.content),
    });
  }

  const { resource } = await container
    .item(conversation.id, conversation.userId)
    .patch(operations);
  return resource;
}

async function appendConversationAttachments(conversation, attachments) {
  if (attachments.length === 0) {
    return conversation;
  }

  const container = await getConversationContainer();
  const operations = [];
  if (Array.isArray(conversation.attachments)) {
    for (const attachment of attachments) {
      operations.push({ op: "add", path: "/attachments/-", value: attachment });
    }
  } else {
    operations.push({ op: "set", path: "/attachments", value: attachments });
  }
  operations.push(...conversationLifecycleOperations());

  const { resource } = await container
    .item(conversation.id, conversation.userId)
    .patch(operations);
  return resource;
}

async function updateConversationProperties(conversation, { title, pinned }) {
  const operations = [];
  if (title !== undefined) {
    operations.push({ op: "set", path: "/title", value: makeConversationTitle(title) });
  }
  if (pinned !== undefined) {
    operations.push({ op: "set", path: "/pinned", value: !!pinned });
  }
  if (operations.length === 0) return conversation;
  operations.push(...conversationLifecycleOperations());
  const container = await getConversationContainer();
  const { resource } = await container
    .item(conversation.id, conversation.userId)
    .patch(operations);
  return resource;
}

async function appendGeneratedResult(conversation, attachment, assistantMessage) {
  const operations = [];
  if (Array.isArray(conversation.attachments)) {
    operations.push({ op: "add", path: "/attachments/-", value: attachment });
  } else {
    operations.push({ op: "set", path: "/attachments", value: [attachment] });
  }
  operations.push({ op: "add", path: "/messages/-", value: assistantMessage });
  operations.push(...conversationLifecycleOperations());
  const container = await getConversationContainer();
  const { resource } = await container
    .item(conversation.id, conversation.userId)
    .patch(operations);
  return resource;
}

async function deleteConversationData(conversation) {
  for (const attachment of Array.isArray(conversation.attachments)
    ? conversation.attachments
    : []) {
    await deleteAttachmentBlobIfPossible(attachment.blobUrl || attachment.url || "");
  }
  const container = await getConversationContainer();
  await container.item(conversation.id, conversation.userId).delete();
}

function normalizeAttachmentIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
}

function resolveAttachments(conversation, attachmentIds) {
  const requestedIds = new Set(normalizeAttachmentIds(attachmentIds));
  if (requestedIds.size === 0) {
    return [];
  }

  const attachments = Array.isArray(conversation?.attachments)
    ? conversation.attachments
    : [];
  const resolved = attachments.filter((item) => requestedIds.has(String(item.id)));
  if (resolved.length !== requestedIds.size) {
    throw new Error("One or more attachments do not belong to this conversation.");
  }
  return resolved;
}

function toClientAttachment(attachment) {
  return {
    id: attachment.id,
    name: attachment.name,
    contentType: attachment.contentType,
    size: attachment.size,
    createdAt: attachment.createdAt,
    kind: attachment.kind || "upload",
    format: attachment.format || "",
    url: signBlobUrlIfPossible(attachment.blobUrl || attachment.url || ""),
  };
}

function toClientConversation(conversation) {
  if (!conversation) {
    return conversation;
  }

  const attachments = Array.isArray(conversation.attachments)
    ? conversation.attachments
    : [];
  const attachmentMap = new Map(
    attachments.map((item) => [String(item.id), toClientAttachment(item)]),
  );
  const messages = Array.isArray(conversation.messages)
    ? conversation.messages.map((message) => ({
        ...message,
        citations: Array.isArray(message.citations)
          ? message.citations.map((citation) => ({
              ...citation,
              url: signBlobUrlIfPossible(citation.url || ""),
            }))
          : message.citations,
        attachments: normalizeAttachmentIds(message.attachmentIds)
          .map((id) => attachmentMap.get(id))
          .filter(Boolean),
      }))
    : [];

  return {
    ...conversation,
    expiresAt: resolveConversationExpiresAt(conversation),
    attachments: [...attachmentMap.values()],
    messages,
  };
}

function toSafeInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.floor(n);
}

function toIsoStart(dateText) {
  if (!dateText) {
    return "";
  }
  const t = `${String(dateText).trim()}T00:00:00.000Z`;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

function toIsoEnd(dateText) {
  if (!dateText) {
    return "";
  }
  const t = `${String(dateText).trim()}T23:59:59.999Z`;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

async function listAuditLogs({
  limit = 100,
  userId = "",
  action = "",
  status = "",
  startDate = "",
  endDate = "",
}) {
  const container = await getAuditContainer();
  const where = [];
  const parameters = [];

  if (userId) {
    where.push("c.userId = @userId");
    parameters.push({ name: "@userId", value: userId });
  }
  if (action) {
    where.push("c.action = @action");
    parameters.push({ name: "@action", value: action });
  }
  if (status) {
    const statusNum = toSafeInt(status, -1);
    if (statusNum >= 100) {
      where.push("c.statusCode = @statusCode");
      parameters.push({ name: "@statusCode", value: statusNum });
    }
  }

  const startIso = toIsoStart(startDate);
  const endIso = toIsoEnd(endDate);
  if (startIso) {
    where.push("c.createdAt >= @startIso");
    parameters.push({ name: "@startIso", value: startIso });
  }
  if (endIso) {
    where.push("c.createdAt <= @endIso");
    parameters.push({ name: "@endIso", value: endIso });
  }

  const whereClause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  const safeLimit = Math.max(10, Math.min(500, toSafeInt(limit, 100)));

  const querySpec = {
    query:
      `SELECT TOP ${safeLimit} ` +
      "c.id, c.createdAt, c.action, c.method, c.path, c.statusCode, c.success, c.latencyMs, " +
      "c.userId, c.userName, c.ip, c.userAgent, c.errorMessage, c.details " +
      `FROM c${whereClause} ORDER BY c.createdAt DESC`,
    parameters,
  };
  const { resources } = await container.items.query(querySpec).fetchAll();
  return resources || [];
}

function summarizeAuditItems(items) {
  const summary = {
    total: items.length,
    successCount: 0,
    failCount: 0,
    avgLatencyMs: 0,
    users: [],
    actions: [],
  };
  if (items.length === 0) {
    return summary;
  }

  let latencyTotal = 0;
  const userMap = new Map();
  const actionMap = new Map();

  for (const item of items) {
    if (item.success) {
      summary.successCount += 1;
    } else {
      summary.failCount += 1;
    }
    latencyTotal += Number(item.latencyMs || 0);

    const userKey = String(item.userName || item.userId || "unknown");
    userMap.set(userKey, (userMap.get(userKey) || 0) + 1);

    const actionKey = String(item.action || "unknown");
    actionMap.set(actionKey, (actionMap.get(actionKey) || 0) + 1);
  }

  summary.avgLatencyMs = Math.round(latencyTotal / items.length);
  summary.users = [...userMap.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  summary.actions = [...actionMap.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  return summary;
}

function getUsageBreakdownValue(doc, prefix, suffix) {
  return Math.max(0, Number(doc?.[`${prefix}${suffix}`] || 0));
}

function makeEffortUsageBreakdown(doc) {
  return [...GPT56_REASONING_EFFORTS, "unknown"].map((effort) => {
    const field =
      effort === "unknown"
        ? "Unknown"
        : `${effort[0].toUpperCase()}${effort.slice(1)}`;
    return {
      effort,
      weight: getReasoningEffortWeight(effort),
      requestCount: getUsageBreakdownValue(doc, `effort${field}`, "Requests"),
      rawTokens: getUsageBreakdownValue(doc, `effort${field}`, "Tokens"),
      weightedTokens: getUsageBreakdownValue(
        doc,
        `effort${field}`,
        "WeightedTokens",
      ),
    };
  });
}

function makeModelUsageBreakdown(doc) {
  return [
    ["gpt-5.6-sol", "Sol"],
    ["gpt-5.6-terra", "Terra"],
    ["gpt-5.6-luna", "Luna"],
    ["rag", "Rag"],
    ["unknown", "Unknown"],
  ].map(([modelId, field]) => ({
    modelId,
    requestCount: getUsageBreakdownValue(doc, `model${field}`, "Requests"),
    rawTokens: getUsageBreakdownValue(doc, `model${field}`, "Tokens"),
    estimatedCostUsd:
      getUsageBreakdownValue(doc, `model${field}`, "CostNanoUsd") /
      1_000_000_000,
  }));
}

function toAdminUsageRow(doc) {
  const policy = getUsagePolicy({
    userId: doc?.userId,
    userName: doc?.userName,
  });
  const usage = toClientUsage(doc, policy);
  const pricedTokens = Math.max(0, Number(doc?.pricedTokens || 0));
  return {
    userId: String(doc?.userId || ""),
    userName: String(doc?.userName || doc?.userId || "unknown"),
    updatedAt: doc?.updatedAt || "",
    ...usage,
    pricedTokens,
    costCoveragePercentage: usage.rawTokens
      ? Math.min(100, Math.round((pricedTokens / usage.rawTokens) * 10_000) / 100)
      : 0,
    effortBreakdown: makeEffortUsageBreakdown(doc),
    modelBreakdown: makeModelUsageBreakdown(doc),
  };
}

async function listAdminUsage(monthKey) {
  const container = await getUsageContainer();
  const querySpec = {
    query: "SELECT * FROM c WHERE c.monthKey = @monthKey",
    parameters: [{ name: "@monthKey", value: monthKey }],
  };
  const { resources } = await container.items.query(querySpec).fetchAll();
  const users = (resources || [])
    .map((doc) => toAdminUsageRow(doc))
    .sort((a, b) => b.weightedTokens - a.weightedTokens);

  const summary = users.reduce(
    (result, row) => {
      result.requestCount += row.requestCount;
      result.rawTokens += row.rawTokens;
      result.weightedTokens += row.weightedTokens;
      result.reasoningTokens += row.reasoningTokens;
      result.estimatedCostUsd += row.estimatedCostUsd;
      if (!row.unlimited && row.percentage >= 80) result.highUsageUsers += 1;
      return result;
    },
    {
      userCount: users.length,
      requestCount: 0,
      rawTokens: 0,
      weightedTokens: 0,
      reasoningTokens: 0,
      estimatedCostUsd: 0,
      highUsageUsers: 0,
    },
  );

  return { users, summary };
}

function getUsageAccountingConfiguration() {
  return {
    reasoningEffortWeights: Object.fromEntries(
      GPT56_REASONING_EFFORTS.map((effort) => [
        effort,
        getReasoningEffortWeight(effort),
      ]),
    ),
    pricingUsdPerMillionTokens: MODEL_PRICING_USD_PER_MILLION_TOKENS,
    pricingAsOf: "2026-08-26",
    pricingBasis:
      "OpenAI public API token pricing; Azure OpenAI billing and tool-call charges may differ.",
  };
}

function selectBestField(document, candidates) {
  for (const fieldName of candidates) {
    const value = document[fieldName];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function toCitation(result, fallbackId) {
  const doc = result.document || {};
  const title =
    selectBestField(doc, ["title", "name", "fileName", "filename", "source"]) ||
    `Document ${fallbackId}`;

  const url = selectBestField(doc, [
    "url",
    "sourceUrl",
    "source_url",
    "filepath",
    "path",
  ]);
  const signedUrl = signBlobUrlIfPossible(url);

  const snippet =
    selectBestField(doc, ["content", "chunk", "text", "body", "description"]) ||
    JSON.stringify(doc).slice(0, 500);

  return {
    id: String(doc.id ?? doc.key ?? fallbackId),
    title,
    url: signedUrl,
    snippet,
  };
}

function isAzureBlobUrl(parsedUrl) {
  return parsedUrl.hostname.endsWith(".blob.core.windows.net");
}

function sanitizeFileName(value) {
  const raw = String(value || "attachment").split(/[\\/]/).pop() || "attachment";
  const cleaned = raw
    .normalize("NFKC")
    .replace(/[\u0000-\u001f<>:"|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "attachment").slice(0, 160);
}

function validateAttachmentFile(file) {
  const name = sanitizeFileName(file?.name);
  const extension = extname(name).toLowerCase();
  const size = Number(file?.size || 0);

  if (!ATTACHMENT_EXTENSIONS.has(extension)) {
    return { ok: false, error: `Unsupported attachment type: ${extension || "unknown"}` };
  }
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, error: `${name}: file is empty.` };
  }
  if (size > config.attachmentMaxFileBytes) {
    const maxMb = Math.floor(config.attachmentMaxFileBytes / 1024 / 1024);
    return { ok: false, error: `${name}: file exceeds the ${maxMb} MB limit.` };
  }
  return { ok: true, name, extension, size };
}

function makeBlobPath(userId, conversationId, attachmentId, fileName) {
  const safeUserId = encodeURIComponent(String(userId || "unknown"));
  const safeConversationId = encodeURIComponent(String(conversationId || "unknown"));
  return `${safeUserId}/${safeConversationId}/${attachmentId}-${fileName}`;
}

async function uploadAttachmentFile({ file, userId, conversationId }) {
  const validation = validateAttachmentFile(file);
  if (!validation.ok) {
    throw new Error(validation.error);
  }

  const attachmentId = randomUUID();
  const blobName = makeBlobPath(
    userId,
    conversationId,
    attachmentId,
    validation.name,
  );
  const container = await getAttachmentContainer();
  const blobClient = container.getBlockBlobClient(blobName);
  const bytes = Buffer.from(await file.arrayBuffer());
  const contentType = String(file.type || "application/octet-stream");
  await blobClient.uploadData(bytes, {
    blobHTTPHeaders: { blobContentType: contentType },
    metadata: {
      attachmentId,
      conversationId: String(conversationId),
    },
  });

  return {
    id: attachmentId,
    name: validation.name,
    contentType,
    size: validation.size,
    blobUrl: blobClient.url,
    createdAt: nowIso(),
  };
}

async function uploadGeneratedBuffer({
  buffer,
  fileName,
  contentType,
  format,
  userId,
  conversationId,
}) {
  const attachmentId = randomUUID();
  const safeName = sanitizeFileName(fileName);
  const blobName = makeBlobPath(
    userId,
    conversationId,
    attachmentId,
    safeName,
  );
  const container = await getAttachmentContainer();
  const blobClient = container.getBlockBlobClient(blobName);
  const bytes = Buffer.from(buffer);
  await blobClient.uploadData(bytes, {
    blobHTTPHeaders: {
      blobContentType: contentType,
      blobContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    },
    metadata: {
      attachmentId,
      conversationId: String(conversationId),
      kind: "generated",
      format: String(format || ""),
    },
  });
  return {
    id: attachmentId,
    name: safeName,
    contentType,
    size: bytes.length,
    blobUrl: blobClient.url,
    kind: "generated",
    format: String(format || ""),
    createdAt: nowIso(),
  };
}

function signBlobUrlIfPossible(rawUrl) {
  if (!rawUrl || !config.storageAccountName || !config.storageAccountKey) {
    return rawUrl;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  if (!isAzureBlobUrl(parsedUrl)) {
    return rawUrl;
  }

  const accountName = parsedUrl.hostname.split(".")[0] || "";
  if (accountName !== config.storageAccountName) {
    return rawUrl;
  }

  const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
  if (pathParts.length < 2) {
    return rawUrl;
  }

  const containerName = pathParts[0];
  let blobName = pathParts.slice(1).join("/");
  try {
    blobName = decodeURIComponent(blobName);
  } catch {
    return rawUrl;
  }

  try {
    parsedUrl.search = "";
    const sharedKeyCredential = new StorageSharedKeyCredential(
      config.storageAccountName,
      config.storageAccountKey,
    );
    const startsOn = new Date(Date.now() - 5 * 60 * 1000);
    const expiresOn = new Date(
      Date.now() + Math.max(1, config.blobSasExpiryMinutes) * 60 * 1000,
    );

    const sas = generateBlobSASQueryParameters(
      {
        containerName,
        blobName,
        permissions: BlobSASPermissions.parse("r"),
        startsOn,
        expiresOn,
        protocol: "https",
      },
      sharedKeyCredential,
    );

    const sasQuery = new URLSearchParams(sas.toString());
    for (const [key, value] of sasQuery.entries()) {
      parsedUrl.searchParams.set(key, value);
    }

    return parsedUrl.toString();
  } catch {
    return rawUrl;
  }
}

async function deleteAttachmentBlobIfPossible(rawUrl) {
  if (!rawUrl || !config.storageAccountName || !config.storageAccountKey) return;
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return;
  }
  if (!isAzureBlobUrl(parsedUrl)) return;
  const accountName = parsedUrl.hostname.split(".")[0] || "";
  const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
  if (
    accountName !== config.storageAccountName ||
    pathParts[0] !== config.attachmentContainerName ||
    pathParts.length < 2
  ) {
    return;
  }
  let blobName = pathParts.slice(1).join("/");
  try {
    blobName = decodeURIComponent(blobName);
  } catch {
    return;
  }
  try {
    const container = await getAttachmentContainer();
    await container.getBlockBlobClient(blobName).deleteIfExists();
  } catch {
    // Conversation deletion should not fail because a blob was already removed.
  }
}

async function retrieveContext(query, indexName, topK) {
  const client = new SearchClient(config.searchEndpoint, indexName, searchCredential);
  const results = await client.search(query, { top: topK });

  const citations = [];
  for await (const result of results.results) {
    citations.push(toCitation(result, citations.length + 1));
  }

  const context = citations
    .map((item, idx) => `[#${idx + 1}] ${item.title}\n${item.snippet}`)
    .join("\n\n");

  return { citations, context };
}

function extractResponseText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  if (Array.isArray(data?.output_text)) {
    const joined = data.output_text.join("\n").trim();
    if (joined) {
      return joined;
    }
  }

  if (Array.isArray(data?.output)) {
    const chunks = [];
    for (const outputItem of data.output) {
      const contentItems = Array.isArray(outputItem?.content)
        ? outputItem.content
        : [];
      for (const content of contentItems) {
        if (typeof content?.text === "string" && content.text.trim()) {
          chunks.push(content.text.trim());
        }
      }
    }
    if (chunks.length > 0) {
      return chunks.join("\n");
    }
  }

  return "No answer returned from model.";
}

function extractWebCitations(data) {
  const citations = [];
  const seen = new Set();
  const add = (source) => {
    const url = String(source?.url || "").trim();
    if (!url || seen.has(url)) return;
    seen.add(url);
    citations.push({
      id: `web-${citations.length + 1}`,
      title: String(source?.title || source?.name || url),
      url,
      snippet: String(source?.snippet || "Web検索結果"),
      sourceType: "web",
    });
  };

  for (const item of Array.isArray(data?.output) ? data.output : []) {
    for (const source of Array.isArray(item?.action?.sources)
      ? item.action.sources
      : []) {
      add(source);
    }
    for (const result of Array.isArray(item?.results) ? item.results : []) {
      add(result);
    }
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      for (const annotation of Array.isArray(content?.annotations)
        ? content.annotations
        : []) {
        if (annotation?.type === "url_citation") add(annotation);
      }
    }
  }
  return citations;
}

function extractGeneratedImage(data) {
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    if (item?.type === "image_generation_call" && item.result) {
      return Buffer.from(String(item.result), "base64");
    }
  }
  return null;
}

function normalizeTemplateId(value) {
  const id = String(value || "default").trim().toLowerCase();
  return Object.hasOwn(PROMPT_TEMPLATES, id) ? id : "default";
}

function buildInstructions(mode, templateId = "default") {
  if (mode === MODE_RAG) {
    return "You are a RAG assistant. Use only the provided context. If information is insufficient, clearly say so. Keep answer concise and include citation markers like [#1].";
  }

  const templateInstruction = PROMPT_TEMPLATES[normalizeTemplateId(templateId)];
  return [
    "You are a capable workplace assistant. Answer in Japanese unless the user requests another language. Use prior conversation context, attached files, and web sources when available. Be accurate, practical, and clear. Never claim to have inspected content that was not available.",
    "For PDF evidence, cite page numbers when available. For PowerPoint evidence, cite slide numbers. For spreadsheets, cite sheet names and cell ranges. For Word documents, cite headings or sections. Clearly label web sources and preserve their URLs.",
    templateInstruction,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function normalizeMode(value) {
  const mode = String(value || MODE_GPT56).trim().toLowerCase();
  return mode === LEGACY_MODE_GPT54 ? MODE_GPT56 : mode;
}

function normalizeReasoningEffort(value) {
  const effort = String(value || "medium").trim().toLowerCase();
  return REASONING_EFFORTS.has(effort) ? effort : "medium";
}

function normalizeGpt56ModelId(value) {
  const raw = String(value || "").trim().toLowerCase();
  const aliases = {
    "": "",
    "gpt-5.6": "gpt-5.6-sol",
    gpt56: "gpt-5.6-sol",
    sol: "gpt-5.6-sol",
    terra: "gpt-5.6-terra",
    luna: "gpt-5.6-luna",
  };
  return aliases[raw] || raw;
}

function getAttachmentsForMessage(conversation, message) {
  const ids = new Set(normalizeAttachmentIds(message?.attachmentIds));
  if (ids.size === 0) {
    return [];
  }
  return (Array.isArray(conversation?.attachments) ? conversation.attachments : [])
    .filter((attachment) => ids.has(String(attachment.id)));
}

function toModelAttachmentContent(attachment) {
  const url = signBlobUrlIfPossible(attachment.blobUrl || attachment.url || "");
  if (!url) {
    return null;
  }
  if (String(attachment.contentType || "").startsWith("image/")) {
    return { type: "input_image", image_url: url, detail: "auto" };
  }
  return {
    type: "input_file",
    file_url: url,
    filename: attachment.name || "attachment",
  };
}

function buildUserContent(text, attachments) {
  const content = [{ type: "input_text", text: String(text || "") }];
  for (const attachment of attachments) {
    const item = toModelAttachmentContent(attachment);
    if (item) {
      const extension = extname(String(attachment.name || "")).toLowerCase();
      const referenceInstruction =
        extension === ".ppt" || extension === ".pptx"
          ? "根拠を示す場合はスライド番号を明記してください。"
          : extension === ".xls" || extension === ".xlsx" || extension === ".csv"
            ? "根拠を示す場合はシート名とセル範囲を明記してください。"
            : extension === ".pdf"
              ? "根拠を示す場合はページ番号を明記してください。"
              : extension === ".doc" || extension === ".docx"
                ? "根拠を示す場合は見出しまたはセクション名を明記してください。"
                : "";
      content.push({
        type: "input_text",
        text: `添付ファイル: ${attachment.name || "attachment"}。${referenceInstruction}`,
      });
      content.push(item);
    }
  }
  return content;
}

function buildModelInput({ mode, query, context, conversation, attachments }) {
  if (mode === MODE_RAG) {
    return `Question:\n${query}\n\nContext:\n${context || "(no context)"}`;
  }

  const maxMessages = Math.max(
    0,
    Math.min(100, Math.floor(config.chatHistoryMaxMessages || 20)),
  );
  const sourceHistory = (Array.isArray(conversation?.messages)
    ? conversation.messages
    : [])
    .filter((message) => message?.role === "user" || message?.role === "assistant")
    .slice(-maxMessages);
  const currentBytes = attachments.reduce(
    (sum, attachment) => sum + Number(attachment.size || 0),
    0,
  );
  let remainingAttachmentBytes = Math.max(
    0,
    config.attachmentMaxRequestBytes - currentBytes,
  );
  const includedAttachmentIds = new Set(
    attachments.map((attachment) => String(attachment.id)),
  );
  const historicalAttachments = new Map();

  for (let index = sourceHistory.length - 1; index >= 0; index -= 1) {
    const message = sourceHistory[index];
    if (message.role !== "user") continue;
    const included = [];
    for (const attachment of getAttachmentsForMessage(conversation, message)) {
      const id = String(attachment.id);
      const size = Number(attachment.size || 0);
      if (
        includedAttachmentIds.has(id) ||
        !Number.isFinite(size) ||
        size > remainingAttachmentBytes
      ) {
        continue;
      }
      included.push(attachment);
      includedAttachmentIds.add(id);
      remainingAttachmentBytes -= size;
    }
    historicalAttachments.set(index, included);
  }

  const history = sourceHistory.map((message, index) => {
    if (message.role === "user") {
      return {
        role: "user",
        content: buildUserContent(
          message.content,
          historicalAttachments.get(index) || [],
        ),
      };
    }
    return { role: "assistant", content: String(message.content || "") };
  });

  history.push({ role: "user", content: buildUserContent(query, attachments) });
  return history;
}

function validateAssistantPayload(payload, conversation) {
  const attachmentIds = normalizeAttachmentIds(payload?.attachmentIds);
  let attachments;
  try {
    attachments = resolveAttachments(conversation, attachmentIds);
  } catch (error) {
    return {
      ok: false,
      status: 400,
      error: error instanceof Error ? error.message : "Invalid attachments.",
    };
  }
  const query =
    String(payload?.query || "").trim() ||
    (attachments.length > 0 ? "添付ファイルを分析してください。" : "");
  const mode = normalizeMode(payload?.mode);

  if (!query) {
    return { ok: false, status: 400, error: "query is required." };
  }

  if (mode !== MODE_RAG && mode !== MODE_GPT56) {
    return {
      ok: false,
      status: 400,
      error: "mode must be either 'rag' or 'gpt56'.",
    };
  }
  if (mode === MODE_RAG && attachments.length > 0) {
    return {
      ok: false,
      status: 400,
      error: "Attachments are currently supported only in GPT-5.6 mode.",
    };
  }
  const attachmentBytes = attachments.reduce(
    (sum, attachment) => sum + Number(attachment.size || 0),
    0,
  );
  if (attachmentBytes > config.attachmentMaxRequestBytes) {
    const maxMb = Math.floor(config.attachmentMaxRequestBytes / 1024 / 1024);
    return {
      ok: false,
      status: 400,
      error: `Attachments exceed the ${maxMb} MB combined request limit.`,
    };
  }

  const templateId = normalizeTemplateId(payload?.templateId);
  const webSearch = mode === MODE_GPT56 && payload?.webSearch !== false;
  let selectedModel = null;
  let reasoningEffort = null;
  if (mode === MODE_GPT56) {
    const models = getConfiguredGpt56Models();
    const defaultModel = getDefaultGpt56Model(models);
    if (!defaultModel) {
      return {
        ok: false,
        status: 500,
        error:
          "GPT-5.6 deployment is not configured. Set AZURE_OPENAI_DEPLOYMENT_GPT56_SOL, _TERRA, or _LUNA.",
      };
    }
    const requestedModelId = normalizeGpt56ModelId(payload?.modelId);
    selectedModel = requestedModelId
      ? models.find((item) => item.id === requestedModelId)
      : defaultModel;
    if (!selectedModel) {
      return {
        ok: false,
        status: 400,
        error: "The selected GPT-5.6 model is not enabled for this app.",
      };
    }
    const requestedReasoningEffort = String(
      payload?.reasoningEffort || "",
    )
      .trim()
      .toLowerCase();
    if (
      requestedReasoningEffort &&
      !selectedModel.reasoningEfforts.includes(requestedReasoningEffort)
    ) {
      return {
        ok: false,
        status: 400,
        error: "The selected reasoning effort is not enabled for this app.",
      };
    }
    reasoningEffort = normalizeReasoningEffort(requestedReasoningEffort);
    if (!selectedModel.reasoningEfforts.includes(reasoningEffort)) {
      reasoningEffort = selectedModel.defaultReasoningEffort;
    }
  }
  return {
    ok: true,
    query,
    mode,
    attachmentIds,
    attachments,
    templateId,
    webSearch,
    selectedModel,
    reasoningEffort,
  };
}

async function prepareAssistantRequest(
  payload,
  { conversation = null, validated = null } = {},
) {
  const validation = validated || validateAssistantPayload(payload, conversation);
  if (!validation.ok) {
    return validation;
  }
  const {
    query,
    mode,
    attachmentIds,
    attachments,
    templateId,
    webSearch,
    selectedModel,
    reasoningEffort,
  } = validation;

  let indexName = null;
  let topK = null;
  let citations = [];
  let context = "";

  if (mode === MODE_RAG) {
    indexName = String(payload?.indexName || config.defaultSearchIndex || "").trim();
    const requestedTopK = Number(payload?.topK || 5);
    topK = Number.isFinite(requestedTopK)
      ? Math.max(1, Math.min(20, Math.floor(requestedTopK)))
      : 5;

    if (!indexName) {
      return {
        ok: false,
        status: 400,
        error:
          "indexName is required. Pass in request or set AZURE_SEARCH_INDEX.",
      };
    }

    const retrieval = await retrieveContext(query, indexName, topK);
    citations = retrieval.citations;
    context = retrieval.context;
  }

  const deployment =
    mode === MODE_GPT56 ? selectedModel?.deployment : config.openAiDeploymentRag;
  if (!deployment) {
    return {
      ok: false,
      status: 500,
      error: `OpenAI deployment is not configured. Set ${
        mode === MODE_GPT56
          ? "AZURE_OPENAI_DEPLOYMENT_GPT56_SOL, _TERRA, or _LUNA"
          : "AZURE_OPENAI_DEPLOYMENT"
      }.`,
    };
  }

  const meta = {
    mode,
    model: mode === MODE_GPT56 ? selectedModel.id : deployment,
    modelLabel: mode === MODE_GPT56 ? selectedModel.label : "社内RAG",
    indexName,
    topK,
    retrieved: citations.length,
    attachmentCount: attachments.length,
    templateId,
    webSearch,
    reasoningEffort: mode === MODE_GPT56 ? reasoningEffort : null,
  };

  const body = {
    model: deployment,
    instructions: buildInstructions(mode, templateId),
    input: buildModelInput({ mode, query, context, conversation, attachments }),
    max_output_tokens: Math.max(
      256,
      Math.min(32000, Math.floor(config.openAiMaxOutputTokens || 4000)),
    ),
  };
  if (mode === MODE_GPT56) {
    body.reasoning = { effort: meta.reasoningEffort };
    if (webSearch) {
      body.tools = [{ type: "web_search" }];
      body.tool_choice = "auto";
      body.include = ["web_search_call.action.sources"];
    }
  }

  return { ok: true, query, mode, citations, meta, body, attachmentIds };
}

async function requestAssistant(prepared, { stream = false } = {}) {
  const url = `${config.openAiEndpoint}/openai/v1/responses`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": config.openAiApiKey,
    },
    body: JSON.stringify({ ...prepared.body, stream }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Azure OpenAI error (${response.status}): ${detail}`);
  }

  if (stream) {
    return response;
  }

  const data = await response.json();
  return {
    answer: extractResponseText(data),
    responseId: data?.id || "",
    usage: data?.usage || null,
    webCitations: extractWebCitations(data),
    raw: data,
  };
}

function estimatePreparedInputTokens(prepared) {
  const serialized = JSON.stringify({
    instructions: prepared?.body?.instructions || "",
    input: prepared?.body?.input || "",
    tools: prepared?.body?.tools || [],
  });
  const textEstimate = Math.ceil(serialized.length / 2);
  const attachmentEstimate = Number(prepared?.meta?.attachmentCount || 0) * 5_000;
  return Math.max(1, textEstimate + attachmentEstimate);
}

async function countPreparedInputTokens(prepared) {
  if (!config.openAiInputTokenCountEnabled) {
    return estimatePreparedInputTokens(prepared);
  }
  try {
    const countBody = { ...prepared.body };
    delete countBody.max_output_tokens;
    const response = await fetch(
      `${config.openAiEndpoint}/openai/v1/responses/input_tokens`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": config.openAiApiKey,
        },
        body: JSON.stringify(countBody),
      },
    );
    if (!response.ok) return estimatePreparedInputTokens(prepared);
    const data = await response.json();
    const counted = Number(data?.input_tokens || 0);
    return counted > 0 ? counted : estimatePreparedInputTokens(prepared);
  } catch {
    return estimatePreparedInputTokens(prepared);
  }
}

function parseArtifactSpecText(text) {
  const raw = String(text || "").trim();
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error("生成資料の構造化データを解析できませんでした。");
  }
}

async function prepareArtifactRequest(payload, conversation, validation, format) {
  const prepared = await prepareAssistantRequest(
    { ...payload, mode: MODE_GPT56, query: validation.query },
    { conversation, validated: validation },
  );
  if (!prepared.ok) return prepared;

  if (format === "png") {
    if (!config.imageGenerationEnabled) {
      return {
        ok: false,
        status: 503,
        error: "画像生成機能は現在無効です。",
      };
    }
    prepared.body.instructions = [
      buildInstructions(MODE_GPT56, validation.templateId),
      "ユーザーの依頼に沿った業務利用可能な画像を1枚生成してください。画像内に文字を入れる場合は日本語の可読性を優先してください。",
    ].join("\n\n");
    prepared.body.tools = [{ type: "image_generation" }];
    prepared.body.tool_choice = { type: "image_generation" };
    delete prepared.body.include;
    prepared.meta.webSearch = false;
    prepared.meta.artifactFormat = format;
    return prepared;
  }

  prepared.body.instructions = [
    buildInstructions(MODE_GPT56, validation.templateId),
    `ユーザーの依頼を${format.toUpperCase()}資料に変換するための構造化データを作成してください。タイトル、要約、セクション、表を具体的に記述してください。Excelの場合はworksheetsへシート名と二次元配列の行データを必ず入れてください。`,
  ].join("\n\n");
  prepared.body.text = {
    format: {
      type: "json_schema",
      name: "artifact_spec",
      strict: true,
      schema: ARTIFACT_SPEC_SCHEMA,
    },
  };
  prepared.body.max_output_tokens = Math.max(
    prepared.body.max_output_tokens,
    Math.min(12_000, config.openAiMaxOutputTokens * 2),
  );
  prepared.meta.artifactFormat = format;
  return prepared;
}

function makeGeneratedFileName(title, extension) {
  const base = sanitizeFileName(title || "生成資料")
    .replace(/\.[A-Za-z0-9]+$/, "")
    .slice(0, 100);
  return `${base || "生成資料"}${extension}`;
}

async function runAssistantFromPayload(payload, options = {}) {
  const prepared = await prepareAssistantRequest(payload, options);
  if (!prepared.ok) {
    return prepared;
  }

  let usageLease = null;
  if (options.principal) {
    const inputTokens = await countPreparedInputTokens(prepared);
    usageLease = await reserveUsage(options.principal, {
      inputTokens,
      maxOutputTokens: prepared.body.max_output_tokens,
      modelId:
        prepared.meta.mode === MODE_RAG ? "rag" : prepared.meta.model,
      reasoningEffort: prepared.meta.reasoningEffort,
    });
    if (!usageLease.ok) return makeUsageLimitResult(usageLease);
  }

  let generated;
  try {
    generated = await requestAssistant(prepared);
  } catch (error) {
    if (usageLease?.ok) {
      try {
        await releaseUsage(usageLease);
      } catch {
        // Usage reconciliation must not replace the upstream error.
      }
    }
    throw error;
  }
  let usage = null;
  if (usageLease?.ok) {
    try {
      usage = await settleUsage(usageLease, generated.usage, {
        chargeUnknown: !generated.usage,
      });
    } catch {
      usage = usageLease.usage || null;
    }
  }
  prepared.meta.usage = calculateUsageAccounting(
    generated.usage
      ? normalizeResponseUsage(generated.usage)
      : makeLeaseFallbackUsage(usageLease),
    {
      modelId: prepared.meta.model,
      reasoningEffort: prepared.meta.reasoningEffort,
    },
  );
  return {
    ok: true,
    answer: generated.answer,
    responseId: generated.responseId,
    citations: [...prepared.citations, ...generated.webCitations],
    meta: prepared.meta,
    usage: generated.usage,
    usageStatus: usage,
    query: prepared.query,
    attachmentIds: prepared.attachmentIds,
  };
}

function parseSseData(block) {
  const data = String(block || "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") {
    return null;
  }
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function takeNextSseBlock(buffer) {
  const match = buffer.match(/\r?\n\r?\n/);
  if (!match || match.index === undefined) {
    return null;
  }
  return {
    block: buffer.slice(0, match.index),
    rest: buffer.slice(match.index + match[0].length),
  };
}

function makeSseChunk(encoder, event, data) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function makeStreamingResponse({
  req,
  upstream,
  conversation,
  userSavedConversation,
  prepared,
  usageLease,
  principal,
  startedAt,
}) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let reader = null;
  let clientCancelled = false;

  const body = new ReadableStream({
    async start(controller) {
      let answer = "";
      let finalResponse = null;
      let statusCode = 200;
      let errorMessage = "";
      let usageSettled = false;
      let usageStatus = usageLease?.usage || null;
      const settleStreamUsage = async (responseUsage, chargeUnknown) => {
        if (!usageLease?.ok || usageSettled) return usageStatus;
        usageSettled = true;
        try {
          usageStatus = await settleUsage(usageLease, responseUsage, {
            chargeUnknown,
          });
        } catch {
          usageStatus = usageLease.usage || null;
        }
        return usageStatus;
      };
      const send = (event, data) => {
        try {
          controller.enqueue(makeSseChunk(encoder, event, data));
        } catch {
          // The browser may have disconnected. Persistence continues server-side.
        }
      };

      send("conversation", {
        phase: "user_saved",
        conversation: toClientConversation(userSavedConversation),
        usage: usageStatus,
      });

      try {
        if (!upstream.body) {
          throw new Error("Azure OpenAI returned an empty stream.");
        }
        reader = upstream.body.getReader();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let next = takeNextSseBlock(buffer);
          while (next) {
            buffer = next.rest;
            const event = parseSseData(next.block);
            if (event?.type === "response.output_text.delta") {
              const delta = String(event.delta || "");
              answer += delta;
              if (delta) send("delta", { delta });
            } else if (event?.type === "response.completed") {
              finalResponse = event.response || null;
            } else if (event?.type === "response.incomplete") {
              finalResponse = event.response || null;
              prepared.meta.incomplete = true;
            } else if (
              event?.type === "error" ||
              event?.type === "response.failed"
            ) {
              const message =
                event?.error?.message ||
                event?.response?.error?.message ||
                `Azure OpenAI stream ended with ${event.type}.`;
              throw new Error(message);
            }
            next = takeNextSseBlock(buffer);
          }
        }

        if (clientCancelled) {
          statusCode = 499;
          prepared.meta.incomplete = true;
          prepared.meta.stopped = true;
          if (!answer) {
            errorMessage = "Generation stopped by client.";
            return;
          }
        }

        if (!answer && finalResponse) {
          answer = extractResponseText(finalResponse);
          if (answer) send("delta", { delta: answer });
        }
        if (!answer) {
          answer = "No answer returned from model.";
          send("delta", { delta: answer });
        }

        const finalCitations = [
          ...prepared.citations,
          ...extractWebCitations(finalResponse),
        ];
        usageStatus = await settleStreamUsage(
          finalResponse?.usage || null,
          !finalResponse?.usage,
        );
        prepared.meta.usage = calculateUsageAccounting(
          finalResponse?.usage
            ? normalizeResponseUsage(finalResponse.usage)
            : makeLeaseFallbackUsage(usageLease),
          {
            modelId: prepared.meta.model,
            reasoningEffort: prepared.meta.reasoningEffort,
          },
        );

        const assistantMessage = {
          id: randomUUID(),
          role: "assistant",
          content: answer,
          citations: finalCitations,
          meta: prepared.meta,
          responseId: finalResponse?.id || "",
          createdAt: nowIso(),
        };
        const saved = await appendConversationMessage(
          userSavedConversation,
          assistantMessage,
        );
        send("done", {
          answer,
          citations: finalCitations,
          meta: prepared.meta,
          usage: usageStatus,
          conversation: toClientConversation(saved),
        });
      } catch (error) {
        statusCode = 500;
        errorMessage = error instanceof Error ? error.message : "Streaming failed.";
        usageStatus = await settleStreamUsage(null, true);
        let latestConversation = userSavedConversation;
        try {
          latestConversation =
            (await getConversation(conversation.userId, conversation.id)) ||
            userSavedConversation;
        } catch {
          // Use the conversation returned after the user message was saved.
        }
        send("error", {
          error: errorMessage,
          userMessageSaved: true,
          usage: usageStatus,
          conversation: toClientConversation(latestConversation),
        });
      } finally {
        if (!usageSettled) {
          usageStatus = await settleStreamUsage(null, true);
        }
        await writeAuditLog({
          req,
          principal,
          action: "chat.message.stream",
          statusCode,
          latencyMs: Date.now() - startedAt,
          errorMessage,
          details: {
            conversationId: conversation.id,
            mode: prepared.meta?.mode || "",
            attachmentCount: prepared.meta?.attachmentCount || 0,
            model: prepared.meta?.model || "",
            reasoningEffort: prepared.meta?.reasoningEffort || null,
            totalTokens: prepared.meta?.usage?.totalTokens || 0,
            weightedTokens: prepared.meta?.usage?.weightedTokens || 0,
            estimatedCostUsd: prepared.meta?.usage?.estimatedCostUsd || 0,
          },
        });
        try {
          controller.close();
        } catch {
          // Stream was already closed by the client.
        }
      }
    },
    async cancel() {
      clientCancelled = true;
      try {
        await reader?.cancel();
      } catch {
        // Ignore cancellation failures.
      }
    },
  });

  return {
    status: 200,
    body,
    headers: {
      ...getCorsHeaders(req),
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  };
}

app.http("health", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "health",
  handler: async (req) => {
    if (req.method === "OPTIONS") {
      return { status: 204, headers: getCorsHeaders(req) };
    }
    return jsonResponse(req, 200, { ok: true });
  },
});

app.http("model-list", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "models",
  handler: async (req) => {
    if (req.method === "OPTIONS") {
      return { status: 204, headers: getCorsHeaders(req) };
    }
    const startedAt = Date.now();
    let principal = null;
    let statusCode = 500;
    let errorMessage = "";
    try {
      const authContext = await getAuthContext(req);
      if (!authContext.ok) {
        statusCode = 401;
        errorMessage = authContext.message || "";
        return jsonResponse(req, 401, { error: authContext.message });
      }
      principal = authContext.principal;
      const configuredModels = getConfiguredGpt56Models();
      const defaultModel = getDefaultGpt56Model(configuredModels);
      statusCode = 200;
      return jsonResponse(req, 200, {
        defaultModelId: defaultModel?.id || null,
        models: configuredModels.map((model) => toClientModel(model)),
      });
    } catch (error) {
      errorMessage =
        error instanceof Error ? error.message : "Model list lookup failed.";
      return jsonResponse(req, 500, { error: errorMessage });
    } finally {
      await writeAuditLog({
        req,
        principal,
        action: "models.list",
        statusCode,
        latencyMs: Date.now() - startedAt,
        errorMessage,
      });
    }
  },
});

app.http("rag-search", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "rag/search",
  handler: async (req) => {
    if (req.method === "OPTIONS") {
      return { status: 204, headers: getCorsHeaders(req) };
    }

    const startedAt = Date.now();
    let principal = null;
    let statusCode = 500;
    let errorMessage = "";
    let details = {};

    try {
      const authContext = await getAuthContext(req);
      if (!authContext.ok) {
        statusCode = 401;
        errorMessage = authContext.message || "";
        return jsonResponse(req, 401, { error: authContext.message });
      }
      principal = authContext.principal;

      let payload = {};
      try {
        payload = await req.json();
      } catch {
        statusCode = 400;
        errorMessage = "Invalid JSON body.";
        return jsonResponse(req, 400, { error: "Invalid JSON body." });
      }
      const result = await runAssistantFromPayload(
        {
          ...payload,
          mode: payload?.mode || MODE_RAG,
        },
        { principal },
      );
      if (!result.ok) {
        statusCode = result.status;
        errorMessage = result.error || "";
        return jsonResponse(req, result.status, {
          error: result.error,
          code: result.code,
          usage: result.usage,
        });
      }

      statusCode = 200;
      details = {
        mode: result.meta?.mode || "",
        indexName: result.meta?.indexName || "",
        topK: result.meta?.topK || null,
        retrieved: result.meta?.retrieved || 0,
      };
      return jsonResponse(req, 200, {
        answer: result.answer,
        citations: result.citations,
        meta: result.meta,
        usage: result.usageStatus,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown server error";
      statusCode = 500;
      errorMessage = message;
      return jsonResponse(req, 500, { error: message });
    } finally {
      await writeAuditLog({
        req,
        principal,
        action: "rag.search",
        statusCode,
        latencyMs: Date.now() - startedAt,
        errorMessage,
        details,
      });
    }
  },
});

app.http("chat-new", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "chat/new",
  handler: async (req) => {
    if (req.method === "OPTIONS") {
      return { status: 204, headers: getCorsHeaders(req) };
    }

    const startedAt = Date.now();
    let principal = null;
    let statusCode = 500;
    let errorMessage = "";
    let details = {};

    try {
      const authContext = await getAuthContext(req);
      if (!authContext.ok) {
        statusCode = 401;
        errorMessage = authContext.message || "";
        return jsonResponse(req, 401, { error: authContext.message });
      }
      principal = authContext.principal;

      let payload = {};
      try {
        payload = await req.json();
      } catch {
        payload = {};
      }

      const conversation = await createConversation(
        authContext.principal.userId,
        String(payload?.title || ""),
      );

      statusCode = 200;
      details = {
        conversationId: conversation.id,
      };
      return jsonResponse(req, 200, {
        conversation: summarizeConversation(conversation),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown server error";
      statusCode = 500;
      errorMessage = message;
      return jsonResponse(req, 500, { error: message });
    } finally {
      await writeAuditLog({
        req,
        principal,
        action: "chat.new",
        statusCode,
        latencyMs: Date.now() - startedAt,
        errorMessage,
        details,
      });
    }
  },
});

app.http("chat-list", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "chat/list",
  handler: async (req) => {
    if (req.method === "OPTIONS") {
      return { status: 204, headers: getCorsHeaders(req) };
    }

    const startedAt = Date.now();
    let principal = null;
    let statusCode = 500;
    let errorMessage = "";
    let details = {};

    try {
      const authContext = await getAuthContext(req);
      if (!authContext.ok) {
        statusCode = 401;
        errorMessage = authContext.message || "";
        return jsonResponse(req, 401, { error: authContext.message });
      }
      principal = authContext.principal;

      const items = await listConversations(authContext.principal.userId, {
        query: req.query.get("q") || "",
      });
      statusCode = 200;
      details = { conversationCount: items.length };
      return jsonResponse(req, 200, { conversations: items });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown server error";
      statusCode = 500;
      errorMessage = message;
      return jsonResponse(req, 500, { error: message });
    } finally {
      await writeAuditLog({
        req,
        principal,
        action: "chat.list",
        statusCode,
        latencyMs: Date.now() - startedAt,
        errorMessage,
        details,
      });
    }
  },
});

app.http("chat-get", {
  methods: ["GET", "PATCH", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  route: "chat/{id}",
  handler: async (req) => {
    if (req.method === "OPTIONS") {
      return { status: 204, headers: getCorsHeaders(req) };
    }

    const startedAt = Date.now();
    let principal = null;
    let statusCode = 500;
    let errorMessage = "";
    let details = {};
    let auditAction = "chat.get";

    try {
      const authContext = await getAuthContext(req);
      if (!authContext.ok) {
        statusCode = 401;
        errorMessage = authContext.message || "";
        return jsonResponse(req, 401, { error: authContext.message });
      }
      principal = authContext.principal;

      const conversationId = String(req.params?.id || "").trim();
      if (!conversationId) {
        statusCode = 400;
        errorMessage = "conversation id is required.";
        return jsonResponse(req, 400, { error: "conversation id is required." });
      }

      const conversation = await getConversation(
        authContext.principal.userId,
        conversationId,
      );

      if (!conversation) {
        statusCode = 404;
        errorMessage = "conversation not found.";
        return jsonResponse(req, 404, { error: "conversation not found." });
      }

      if (req.method === "DELETE") {
        auditAction = "chat.delete";
        await deleteConversationData(conversation);
        statusCode = 200;
        details = { conversationId };
        return jsonResponse(req, 200, { deleted: true, id: conversationId });
      }

      if (req.method === "PATCH") {
        auditAction = "chat.update";
        let payload = {};
        try {
          payload = await req.json();
        } catch {
          statusCode = 400;
          errorMessage = "Invalid JSON body.";
          return jsonResponse(req, 400, { error: errorMessage });
        }
        const hasTitle = Object.hasOwn(payload || {}, "title");
        const hasPinned = Object.hasOwn(payload || {}, "pinned");
        if (!hasTitle && !hasPinned) {
          statusCode = 400;
          errorMessage = "title or pinned is required.";
          return jsonResponse(req, 400, { error: errorMessage });
        }
        const updated = await updateConversationProperties(conversation, {
          title: hasTitle ? String(payload.title || "") : undefined,
          pinned: hasPinned ? !!payload.pinned : undefined,
        });
        statusCode = 200;
        details = { conversationId, pinned: !!updated.pinned };
        return jsonResponse(req, 200, {
          conversation: toClientConversation(updated),
          summary: summarizeConversation(updated),
        });
      }

      statusCode = 200;
      details = { conversationId };
      return jsonResponse(req, 200, {
        conversation: toClientConversation(conversation),
      });
    } catch (error) {
      if (error?.code === 404) {
        statusCode = 404;
        errorMessage = "conversation not found.";
        return jsonResponse(req, 404, { error: "conversation not found." });
      }
      const message =
        error instanceof Error ? error.message : "Unknown server error";
      statusCode = 500;
      errorMessage = message;
      return jsonResponse(req, 500, { error: message });
    } finally {
      await writeAuditLog({
        req,
        principal,
        action: auditAction,
        statusCode,
        latencyMs: Date.now() - startedAt,
        errorMessage,
        details,
      });
    }
  },
});

app.http("chat-attachments", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "chat/{id}/attachments",
  handler: async (req) => {
    if (req.method === "OPTIONS") {
      return { status: 204, headers: getCorsHeaders(req) };
    }

    const startedAt = Date.now();
    let principal = null;
    let statusCode = 500;
    let errorMessage = "";
    let details = {};

    try {
      const authContext = await getAuthContext(req);
      if (!authContext.ok) {
        statusCode = 401;
        errorMessage = authContext.message || "";
        return jsonResponse(req, 401, { error: authContext.message });
      }
      principal = authContext.principal;

      const conversationId = String(req.params?.id || "").trim();
      if (!conversationId) {
        statusCode = 400;
        errorMessage = "conversation id is required.";
        return jsonResponse(req, 400, { error: errorMessage });
      }

      const conversation = await getConversation(principal.userId, conversationId);
      if (!conversation) {
        statusCode = 404;
        errorMessage = "conversation not found.";
        return jsonResponse(req, 404, { error: errorMessage });
      }

      let formData;
      try {
        formData = await req.formData();
      } catch {
        statusCode = 400;
        errorMessage = "Invalid multipart form data.";
        return jsonResponse(req, 400, { error: errorMessage });
      }

      const files = formData
        .getAll("files")
        .filter((value) => value && typeof value.arrayBuffer === "function");
      const maxFiles = Math.max(1, Math.min(10, config.attachmentMaxFiles || 5));
      if (files.length === 0) {
        statusCode = 400;
        errorMessage = "At least one file is required.";
        return jsonResponse(req, 400, { error: errorMessage });
      }
      if (files.length > maxFiles) {
        statusCode = 400;
        errorMessage = `A maximum of ${maxFiles} files can be uploaded at once.`;
        return jsonResponse(req, 400, { error: errorMessage });
      }

      for (const file of files) {
        const validation = validateAttachmentFile(file);
        if (!validation.ok) {
          statusCode = 400;
          errorMessage = validation.error;
          return jsonResponse(req, 400, { error: errorMessage });
        }
      }

      const attachments = [];
      for (const file of files) {
        attachments.push(
          await uploadAttachmentFile({
            file,
            userId: principal.userId,
            conversationId,
          }),
        );
      }
      const saved = await appendConversationAttachments(conversation, attachments);

      statusCode = 200;
      details = {
        conversationId,
        attachmentCount: attachments.length,
        totalBytes: attachments.reduce((sum, item) => sum + item.size, 0),
      };
      return jsonResponse(req, 200, {
        attachments: attachments.map((item) => toClientAttachment(item)),
        conversation: toClientConversation(saved),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Attachment upload failed.";
      statusCode = 500;
      errorMessage = message;
      return jsonResponse(req, 500, { error: message });
    } finally {
      await writeAuditLog({
        req,
        principal,
        action: "chat.attachments",
        statusCode,
        latencyMs: Date.now() - startedAt,
        errorMessage,
        details,
      });
    }
  },
});

app.http("chat-artifact", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "chat/{id}/artifact",
  handler: async (req) => {
    if (req.method === "OPTIONS") {
      return { status: 204, headers: getCorsHeaders(req) };
    }

    const startedAt = Date.now();
    let principal = null;
    let statusCode = 500;
    let errorMessage = "";
    let details = {};
    let userSavedConversation = null;
    let usageLease = null;
    let usageSettled = false;

    try {
      const authContext = await getAuthContext(req);
      if (!authContext.ok) {
        statusCode = 401;
        errorMessage = authContext.message || "";
        return jsonResponse(req, 401, { error: authContext.message });
      }
      principal = authContext.principal;

      const conversationId = String(req.params?.id || "").trim();
      let payload = {};
      try {
        payload = await req.json();
      } catch {
        statusCode = 400;
        errorMessage = "Invalid JSON body.";
        return jsonResponse(req, 400, { error: errorMessage });
      }
      const format = String(payload?.format || "").trim().toLowerCase();
      if (!ARTIFACT_FORMATS.has(format)) {
        statusCode = 400;
        errorMessage = "format must be pptx, docx, xlsx, pdf, or png.";
        return jsonResponse(req, 400, { error: errorMessage });
      }

      const conversation = await getConversation(principal.userId, conversationId);
      if (!conversation) {
        statusCode = 404;
        errorMessage = "conversation not found.";
        return jsonResponse(req, 404, { error: errorMessage });
      }
      const validation = validateAssistantPayload(
        { ...payload, mode: MODE_GPT56 },
        conversation,
      );
      if (!validation.ok) {
        statusCode = validation.status;
        errorMessage = validation.error || "";
        return jsonResponse(req, validation.status, { error: validation.error });
      }

      const userMessage = {
        id: randomUUID(),
        role: "user",
        content: validation.query,
        attachmentIds: validation.attachmentIds,
        requestedArtifactFormat: format,
        createdAt: nowIso(),
      };
      userSavedConversation = await appendConversationMessage(
        conversation,
        userMessage,
        {
          updateTitle:
            !conversation.title || conversation.title === "新しいチャット",
        },
      );

      const prepared = await prepareArtifactRequest(
        payload,
        conversation,
        validation,
        format,
      );
      if (!prepared.ok) {
        statusCode = prepared.status;
        errorMessage = prepared.error || "";
        return jsonResponse(req, prepared.status, {
          error: prepared.error,
          userMessageSaved: true,
          conversation: toClientConversation(userSavedConversation),
        });
      }

      const inputTokens = await countPreparedInputTokens(prepared);
      usageLease = await reserveUsage(principal, {
        inputTokens,
        maxOutputTokens: prepared.body.max_output_tokens,
        modelId:
          prepared.meta.mode === MODE_RAG ? "rag" : prepared.meta.model,
        reasoningEffort: prepared.meta.reasoningEffort,
      });
      if (!usageLease.ok) {
        const limitResult = makeUsageLimitResult(usageLease);
        statusCode = limitResult.status;
        errorMessage = limitResult.error;
        return jsonResponse(req, limitResult.status, {
          error: limitResult.error,
          code: limitResult.code,
          usage: limitResult.usage,
          userMessageSaved: true,
          conversation: toClientConversation(userSavedConversation),
        });
      }

      const generated = await requestAssistant(prepared);
      let usageStatus = null;
      try {
        usageStatus = await settleUsage(usageLease, generated.usage, {
          chargeUnknown: !generated.usage,
        });
      } finally {
        usageSettled = true;
      }
      prepared.meta.usage = calculateUsageAccounting(
        generated.usage
          ? normalizeResponseUsage(generated.usage)
          : makeLeaseFallbackUsage(usageLease),
        {
          modelId: prepared.meta.model,
          reasoningEffort: prepared.meta.reasoningEffort,
        },
      );

      let artifact;
      let artifactTitle;
      if (format === "png") {
        const imageBuffer = extractGeneratedImage(generated.raw);
        if (!imageBuffer?.length) {
          throw new Error("画像生成結果が返されませんでした。");
        }
        artifactTitle = validation.query.slice(0, 80) || "生成画像";
        artifact = {
          buffer: imageBuffer,
          contentType: "image/png",
          extension: ".png",
          format,
          spec: { title: artifactTitle, summary: "" },
        };
      } else {
        artifact = await buildArtifact(
          format,
          parseArtifactSpecText(generated.answer),
          { sources: generated.webCitations },
        );
        artifactTitle = artifact.spec.title;
      }

      const fileName = makeGeneratedFileName(artifactTitle, artifact.extension);
      const attachment = await uploadGeneratedBuffer({
        buffer: artifact.buffer,
        fileName,
        contentType: artifact.contentType,
        format,
        userId: principal.userId,
        conversationId,
      });
      const citations = [...prepared.citations, ...generated.webCitations];
      const assistantMessage = {
        id: randomUUID(),
        role: "assistant",
        content:
          format === "png"
            ? `画像「${fileName}」を生成しました。`
            : `${format.toUpperCase()}ファイル「${fileName}」を生成しました。${artifact.spec.summary ? `\n\n${artifact.spec.summary}` : ""}`,
        citations,
        attachmentIds: [attachment.id],
        meta: prepared.meta,
        responseId: generated.responseId || "",
        createdAt: nowIso(),
      };
      const saved = await appendGeneratedResult(
        userSavedConversation,
        attachment,
        assistantMessage,
      );

      statusCode = 200;
      details = {
        conversationId,
        format,
        model: prepared.meta.model,
        reasoningEffort: prepared.meta.reasoningEffort,
        fileBytes: attachment.size,
        totalTokens: prepared.meta.usage.totalTokens,
        weightedTokens: prepared.meta.usage.weightedTokens,
        estimatedCostUsd: prepared.meta.usage.estimatedCostUsd,
      };
      return jsonResponse(req, 200, {
        artifact: toClientAttachment(attachment),
        usage: usageStatus,
        conversation: toClientConversation(saved),
      });
    } catch (error) {
      if (usageLease?.ok && !usageSettled) {
        try {
          await releaseUsage(usageLease);
        } catch {
          // Preserve the artifact generation error.
        }
      }
      errorMessage =
        error instanceof Error ? error.message : "Artifact generation failed.";
      statusCode = 500;
      return jsonResponse(req, 500, {
        error: errorMessage,
        userMessageSaved: !!userSavedConversation,
        conversation: userSavedConversation
          ? toClientConversation(userSavedConversation)
          : undefined,
      });
    } finally {
      await writeAuditLog({
        req,
        principal,
        action: "chat.artifact",
        statusCode,
        latencyMs: Date.now() - startedAt,
        errorMessage,
        details,
      });
    }
  },
});

app.http("chat-message", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "chat/{id}/message",
  handler: async (req) => {
    if (req.method === "OPTIONS") {
      return { status: 204, headers: getCorsHeaders(req) };
    }

    const startedAt = Date.now();
    let principal = null;
    let statusCode = 500;
    let errorMessage = "";
    let details = {};
    let userSavedConversation = null;

    try {
      const authContext = await getAuthContext(req);
      if (!authContext.ok) {
        statusCode = 401;
        errorMessage = authContext.message || "";
        return jsonResponse(req, 401, { error: authContext.message });
      }
      principal = authContext.principal;

      const conversationId = String(req.params?.id || "").trim();
      if (!conversationId) {
        statusCode = 400;
        errorMessage = "conversation id is required.";
        return jsonResponse(req, 400, { error: errorMessage });
      }

      let payload = {};
      try {
        payload = await req.json();
      } catch {
        statusCode = 400;
        errorMessage = "Invalid JSON body.";
        return jsonResponse(req, 400, { error: errorMessage });
      }

      const conversation = await getConversation(principal.userId, conversationId);
      if (!conversation) {
        statusCode = 404;
        errorMessage = "conversation not found.";
        return jsonResponse(req, 404, { error: errorMessage });
      }

      const validation = validateAssistantPayload(payload, conversation);
      if (!validation.ok) {
        statusCode = validation.status;
        errorMessage = validation.error || "";
        return jsonResponse(req, validation.status, { error: validation.error });
      }

      const userMessage = {
        id: randomUUID(),
        role: "user",
        content: validation.query,
        attachmentIds: validation.attachmentIds,
        createdAt: nowIso(),
      };
      userSavedConversation = await appendConversationMessage(
        conversation,
        userMessage,
        {
          updateTitle:
            !conversation.title || conversation.title === "新しいチャット",
        },
      );

      const result = await runAssistantFromPayload(
        { ...payload, query: validation.query },
        { conversation, validated: validation, principal },
      );
      if (!result.ok) {
        statusCode = result.status;
        errorMessage = result.error || "";
        return jsonResponse(req, result.status, {
          error: result.error,
          code: result.code,
          usage: result.usage,
          userMessageSaved: true,
          conversation: toClientConversation(userSavedConversation),
        });
      }

      const assistantMessage = {
        id: randomUUID(),
        role: "assistant",
        content: result.answer,
        citations: result.citations,
        meta: result.meta,
        responseId: result.responseId || "",
        createdAt: nowIso(),
      };
      const saved = await appendConversationMessage(
        userSavedConversation,
        assistantMessage,
      );

      statusCode = 200;
      details = {
        conversationId,
        mode: result.meta?.mode || "",
        indexName: result.meta?.indexName || "",
        topK: result.meta?.topK || null,
        retrieved: result.meta?.retrieved || 0,
        attachmentCount: result.meta?.attachmentCount || 0,
        model: result.meta?.model || "",
        reasoningEffort: result.meta?.reasoningEffort || null,
        totalTokens: result.meta?.usage?.totalTokens || 0,
        weightedTokens: result.meta?.usage?.weightedTokens || 0,
        estimatedCostUsd: result.meta?.usage?.estimatedCostUsd || 0,
      };
      return jsonResponse(req, 200, {
        answer: result.answer,
        citations: result.citations,
        meta: result.meta,
        usage: result.usageStatus,
        conversation: toClientConversation(saved),
      });
    } catch (error) {
      if (error?.code === 404) {
        statusCode = 404;
        errorMessage = "conversation not found.";
        return jsonResponse(req, 404, { error: errorMessage });
      }
      const message =
        error instanceof Error ? error.message : "Unknown server error";
      statusCode = 500;
      errorMessage = message;
      return jsonResponse(req, 500, {
        error: message,
        userMessageSaved: !!userSavedConversation,
        conversation: userSavedConversation
          ? toClientConversation(userSavedConversation)
          : undefined,
      });
    } finally {
      await writeAuditLog({
        req,
        principal,
        action: "chat.message",
        statusCode,
        latencyMs: Date.now() - startedAt,
        errorMessage,
        details,
      });
    }
  },
});

app.http("chat-message-stream", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "chat/{id}/message/stream",
  handler: async (req) => {
    if (req.method === "OPTIONS") {
      return { status: 204, headers: getCorsHeaders(req) };
    }

    const startedAt = Date.now();
    let principal = null;
    let statusCode = 500;
    let errorMessage = "";
    let details = {};
    let userSavedConversation = null;
    let auditInStream = false;
    let usageLease = null;

    try {
      const authContext = await getAuthContext(req);
      if (!authContext.ok) {
        statusCode = 401;
        errorMessage = authContext.message || "";
        return jsonResponse(req, 401, { error: authContext.message });
      }
      principal = authContext.principal;

      const conversationId = String(req.params?.id || "").trim();
      if (!conversationId) {
        statusCode = 400;
        errorMessage = "conversation id is required.";
        return jsonResponse(req, 400, { error: errorMessage });
      }

      let payload = {};
      try {
        payload = await req.json();
      } catch {
        statusCode = 400;
        errorMessage = "Invalid JSON body.";
        return jsonResponse(req, 400, { error: errorMessage });
      }

      const conversation = await getConversation(principal.userId, conversationId);
      if (!conversation) {
        statusCode = 404;
        errorMessage = "conversation not found.";
        return jsonResponse(req, 404, { error: errorMessage });
      }

      const validation = validateAssistantPayload(payload, conversation);
      if (!validation.ok) {
        statusCode = validation.status;
        errorMessage = validation.error || "";
        return jsonResponse(req, validation.status, { error: validation.error });
      }

      const userMessage = {
        id: randomUUID(),
        role: "user",
        content: validation.query,
        attachmentIds: validation.attachmentIds,
        createdAt: nowIso(),
      };
      userSavedConversation = await appendConversationMessage(
        conversation,
        userMessage,
        {
          updateTitle:
            !conversation.title || conversation.title === "新しいチャット",
        },
      );

      const prepared = await prepareAssistantRequest(
        { ...payload, query: validation.query },
        { conversation, validated: validation },
      );
      if (!prepared.ok) {
        statusCode = prepared.status;
        errorMessage = prepared.error || "";
        return jsonResponse(req, prepared.status, {
          error: prepared.error,
          userMessageSaved: true,
          conversation: toClientConversation(userSavedConversation),
        });
      }

      const inputTokens = await countPreparedInputTokens(prepared);
      usageLease = await reserveUsage(principal, {
        inputTokens,
        maxOutputTokens: prepared.body.max_output_tokens,
        modelId:
          prepared.meta.mode === MODE_RAG ? "rag" : prepared.meta.model,
        reasoningEffort: prepared.meta.reasoningEffort,
      });
      if (!usageLease.ok) {
        const limitResult = makeUsageLimitResult(usageLease);
        statusCode = limitResult.status;
        errorMessage = limitResult.error;
        return jsonResponse(req, limitResult.status, {
          error: limitResult.error,
          code: limitResult.code,
          usage: limitResult.usage,
          userMessageSaved: true,
          conversation: toClientConversation(userSavedConversation),
        });
      }

      const upstream = await requestAssistant(prepared, { stream: true });
      details = {
        conversationId,
        mode: prepared.meta?.mode || "",
        attachmentCount: prepared.meta?.attachmentCount || 0,
        model: prepared.meta?.model || "",
        reasoningEffort: prepared.meta?.reasoningEffort || null,
      };
      statusCode = 200;
      auditInStream = true;
      return makeStreamingResponse({
        req,
        upstream,
        conversation,
        userSavedConversation,
        prepared,
        usageLease,
        principal,
        startedAt,
      });
    } catch (error) {
      if (usageLease?.ok && !auditInStream) {
        try {
          await releaseUsage(usageLease);
        } catch {
          // Preserve the original streaming error.
        }
      }
      const message =
        error instanceof Error ? error.message : "Streaming request failed.";
      statusCode = 500;
      errorMessage = message;
      return jsonResponse(req, 500, {
        error: message,
        userMessageSaved: !!userSavedConversation,
        conversation: userSavedConversation
          ? toClientConversation(userSavedConversation)
          : undefined,
      });
    } finally {
      if (!auditInStream) {
        await writeAuditLog({
          req,
          principal,
          action: "chat.message.stream",
          statusCode,
          latencyMs: Date.now() - startedAt,
          errorMessage,
          details,
        });
      }
    }
  },
});

app.http("usage-me", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "usage/me",
  handler: async (req) => {
    if (req.method === "OPTIONS") {
      return { status: 204, headers: getCorsHeaders(req) };
    }
    const startedAt = Date.now();
    let principal = null;
    let statusCode = 500;
    let errorMessage = "";
    try {
      const authContext = await getAuthContext(req);
      if (!authContext.ok) {
        statusCode = 401;
        errorMessage = authContext.message || "";
        return jsonResponse(req, 401, { error: authContext.message });
      }
      principal = authContext.principal;
      const snapshot = await getUsageSnapshot(principal);
      statusCode = 200;
      return jsonResponse(req, 200, { usage: snapshot.usage });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "Usage lookup failed.";
      return jsonResponse(req, 500, { error: errorMessage });
    } finally {
      await writeAuditLog({
        req,
        principal,
        action: "usage.me",
        statusCode,
        latencyMs: Date.now() - startedAt,
        errorMessage,
      });
    }
  },
});

app.http("audit-me", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "audit/me",
  handler: async (req) => {
    if (req.method === "OPTIONS") {
      return { status: 204, headers: getCorsHeaders(req) };
    }

    const startedAt = Date.now();
    let principal = null;
    let statusCode = 500;
    let errorMessage = "";

    try {
      const authContext = await getAuthContext(req);
      if (!authContext.ok) {
        statusCode = 401;
        errorMessage = authContext.message || "";
        return jsonResponse(req, 401, { error: authContext.message });
      }
      principal = authContext.principal;
      const admin = isAdminPrincipal(principal);
      statusCode = 200;
      return jsonResponse(req, 200, {
        isAdmin: admin,
        canViewUsageAdmin: isUsageDashboardAdminPrincipal(principal),
        userId: principal.userId,
        userName: principal.userName,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown server error";
      statusCode = 500;
      errorMessage = message;
      return jsonResponse(req, 500, { error: message });
    } finally {
      await writeAuditLog({
        req,
        principal,
        action: "audit.me",
        statusCode,
        latencyMs: Date.now() - startedAt,
        errorMessage,
      });
    }
  },
});

app.http("usage-admin", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "usage/admin",
  handler: async (req) => {
    if (req.method === "OPTIONS") {
      return { status: 204, headers: getCorsHeaders(req) };
    }

    const startedAt = Date.now();
    let principal = null;
    let statusCode = 500;
    let errorMessage = "";
    let details = {};
    try {
      const authContext = await getAuthContext(req);
      if (!authContext.ok) {
        statusCode = 401;
        errorMessage = authContext.message || "";
        return jsonResponse(req, 401, { error: authContext.message });
      }
      principal = authContext.principal;
      if (!isUsageDashboardAdminPrincipal(principal)) {
        statusCode = 403;
        errorMessage = "Usage dashboard privileges required.";
        return jsonResponse(req, 403, {
          error: "利用量管理画面を参照する権限がありません。",
        });
      }

      const requestedMonthKey = String(req.query.get("monthKey") || "").trim();
      const monthKey = /^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonthKey)
        ? requestedMonthKey
        : getUsagePeriod().monthKey;
      const report = await listAdminUsage(monthKey);
      statusCode = 200;
      details = { monthKey, userCount: report.users.length };
      return jsonResponse(req, 200, {
        monthKey,
        generatedAt: nowIso(),
        ...report,
        accounting: getUsageAccountingConfiguration(),
      });
    } catch (error) {
      errorMessage =
        error instanceof Error ? error.message : "Usage dashboard lookup failed.";
      return jsonResponse(req, 500, { error: errorMessage });
    } finally {
      await writeAuditLog({
        req,
        principal,
        action: "usage.admin",
        statusCode,
        latencyMs: Date.now() - startedAt,
        errorMessage,
        details,
      });
    }
  },
});

app.http("audit-logs", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "audit/logs",
  handler: async (req) => {
    if (req.method === "OPTIONS") {
      return { status: 204, headers: getCorsHeaders(req) };
    }

    const startedAt = Date.now();
    let principal = null;
    let statusCode = 500;
    let errorMessage = "";
    let details = {};

    try {
      const authContext = await getAuthContext(req);
      if (!authContext.ok) {
        statusCode = 401;
        errorMessage = authContext.message || "";
        return jsonResponse(req, 401, { error: authContext.message });
      }
      principal = authContext.principal;

      if (!isAdminPrincipal(principal)) {
        statusCode = 403;
        errorMessage = "Admin privileges required.";
        return jsonResponse(req, 403, { error: "Admin privileges required." });
      }

      const limit = req.query.get("limit") || "100";
      const userId = req.query.get("userId") || "";
      const action = req.query.get("action") || "";
      const status = req.query.get("status") || "";
      const startDate = req.query.get("startDate") || "";
      const endDate = req.query.get("endDate") || "";

      const items = await listAuditLogs({
        limit,
        userId,
        action,
        status,
        startDate,
        endDate,
      });
      const summary = summarizeAuditItems(items);

      statusCode = 200;
      details = {
        limit,
        userId,
        action,
        status,
        startDate,
        endDate,
        resultCount: items.length,
      };
      return jsonResponse(req, 200, { logs: items, summary });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown server error";
      statusCode = 500;
      errorMessage = message;
      return jsonResponse(req, 500, { error: message });
    } finally {
      await writeAuditLog({
        req,
        principal,
        action: "audit.logs",
        statusCode,
        latencyMs: Date.now() - startedAt,
        errorMessage,
        details,
      });
    }
  },
});
