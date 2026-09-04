export const AUTO_MODEL_ID = "auto";
export const LUNA_MODEL_ID = "gpt-5.6-luna";
export const TERRA_MODEL_ID = "gpt-5.6-terra";

const DOCUMENT_FORMATS = new Set(["pptx", "docx", "xlsx", "pdf"]);
const COMPLEX_TEMPLATES = new Set([
  "business_report",
  "presentation",
  "spreadsheet_analysis",
]);

const HARD_TASK_PATTERN =
  /(要件定義|根本原因|原因究明|アーキテクチャ|セキュリティ監査|脆弱性(?:診断|分析)?|財務分析|統計分析|包括的|複数.{0,12}(比較|照合|統合)|詳細.{0,8}(分析|調査)|契約.{0,8}(分析|レビュー)|法的.{0,8}(分析|判断)|root\s*cause|requirements?\s+(analysis|definition)|architecture\s+(design|review)|security\s+(audit|review)|in-depth\s+(analysis|research))/iu;
const CODE_PATTERN =
  /(コード|プログラム|ソース|実装|API|データベース|SQL|Docker|Azure|React|JavaScript|TypeScript|Python|例外|バグ|デバッグ|code|program|implementation|database|error|exception|bug|debug)/iu;
const ANALYSIS_PATTERN =
  /(分析|比較|検証|評価|設計|最適化|リファクタリング|整合性|トレードオフ|方針|計画|analysis|compare|evaluate|design|optimi[sz]e|refactor|trade-?off|plan)/iu;
const RESEARCH_PATTERN =
  /(調査|最新|出典|引用|市場|動向|競合|レポート|research|latest|sources?|market|trend|competitor|report)/iu;
const CONTINUATION_PATTERN =
  /^(それ|これ|上記|前述|続き|もう少し|さらに|詳しく|修正|改善|同様|その内容|that|this|continue|more detail)/iu;

function normalizeFormat(value) {
  return String(value || "chat").trim().toLowerCase();
}

function normalizeTemplate(value) {
  return String(value || "default").trim().toLowerCase();
}

function normalizeAttachments(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function addReason(reasons, reason) {
  if (reason && !reasons.includes(reason)) reasons.push(reason);
}

/**
 * Chooses only Luna or Terra for automatic routing. Sol is intentionally never
 * returned here and remains available exclusively through manual selection.
 */
export function routeGpt56Model({
  query = "",
  attachments = [],
  templateId = "default",
  format = "chat",
  webSearch = false,
  previousModelId = "",
} = {}) {
  const text = String(query || "").trim();
  const files = normalizeAttachments(attachments);
  const outputFormat = normalizeFormat(format);
  const template = normalizeTemplate(templateId);
  const reasons = [];
  let score = 0;

  if (DOCUMENT_FORMATS.has(outputFormat)) {
    return {
      modelId: TERRA_MODEL_ID,
      score: 100,
      reason: `${outputFormat.toUpperCase()}ファイル生成`,
    };
  }

  if (files.length >= 2) {
    return {
      modelId: TERRA_MODEL_ID,
      score: 100,
      reason: `複数ファイルの比較・統合（${files.length}件）`,
    };
  }

  if (HARD_TASK_PATTERN.test(text)) {
    score += 4;
    addReason(reasons, "高度な分析・設計");
  }

  if (files.length === 1) {
    score += 1;
    addReason(reasons, "添付ファイルの分析");
    const fileSize = Math.max(0, Number(files[0]?.size || 0));
    if (fileSize >= 12 * 1024 * 1024) {
      score += 2;
      addReason(reasons, "大容量ファイル");
    }
  }

  if (text.length >= 1200) {
    score += 3;
    addReason(reasons, "長い依頼内容");
  } else if (text.length >= 600) {
    score += 2;
    addReason(reasons, "長めの依頼内容");
  }

  const isCodeTask = CODE_PATTERN.test(text);
  const isAnalysisTask = ANALYSIS_PATTERN.test(text);
  const isResearchTask = RESEARCH_PATTERN.test(text);

  if (isCodeTask) {
    score += 1;
    addReason(reasons, "プログラム関連");
  }
  if (isAnalysisTask) {
    score += 1;
    addReason(reasons, "分析・設計");
  }
  if (isCodeTask && isAnalysisTask) score += 1;

  if (isResearchTask) {
    score += 1;
    addReason(reasons, "調査・比較");
    if (webSearch) score += 1;
  }

  if (COMPLEX_TEMPLATES.has(template)) {
    score += 2;
    addReason(reasons, "構成が必要な業務資料");
  }

  if (
    previousModelId === TERRA_MODEL_ID &&
    text.length <= 180 &&
    CONTINUATION_PATTERN.test(text)
  ) {
    score += 4;
    addReason(reasons, "Terraで処理した会話の続き");
  }

  if (score >= 4) {
    return {
      modelId: TERRA_MODEL_ID,
      score,
      reason: reasons.slice(0, 3).join("・") || "複雑な依頼",
    };
  }

  return {
    modelId: LUNA_MODEL_ID,
    score,
    reason: reasons.length > 0 ? `通常処理（${reasons.slice(0, 2).join("・")}）` : "通常処理",
  };
}
