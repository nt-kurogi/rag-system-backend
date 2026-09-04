import test from "node:test";
import assert from "node:assert/strict";

import {
  LUNA_MODEL_ID,
  TERRA_MODEL_ID,
  routeGpt56Model,
} from "../src/lib/model-router.js";

test("ordinary questions use Luna", () => {
  const result = routeGpt56Model({ query: "この文章を読みやすく直して" });
  assert.equal(result.modelId, LUNA_MODEL_ID);
  assert.equal(result.reason, "通常処理");
});

test("simple code requests remain on Luna", () => {
  const result = routeGpt56Model({ query: "PythonでCSVを読み込むコードを書いて" });
  assert.equal(result.modelId, LUNA_MODEL_ID);
});

test("complex debugging requests escalate to Terra", () => {
  const result = routeGpt56Model({
    query: "Reactのプログラムで発生するバグの根本原因を調査して、実装修正案を比較して",
  });
  assert.equal(result.modelId, TERRA_MODEL_ID);
  assert.match(result.reason, /高度な分析・設計/);
});

test("multiple attachments escalate to Terra", () => {
  const result = routeGpt56Model({
    query: "違いを教えて",
    attachments: [{ name: "a.pdf" }, { name: "b.pdf" }],
  });
  assert.equal(result.modelId, TERRA_MODEL_ID);
  assert.match(result.reason, /複数ファイル/);
});

test("office document generation escalates to Terra", () => {
  for (const format of ["pptx", "docx", "xlsx", "pdf"]) {
    const result = routeGpt56Model({ query: "作成して", format });
    assert.equal(result.modelId, TERRA_MODEL_ID);
  }
});

test("image generation stays on Luna unless the prompt is complex", () => {
  const result = routeGpt56Model({ query: "青い歯車のアイコンを作って", format: "png" });
  assert.equal(result.modelId, LUNA_MODEL_ID);
});

test("short follow-up keeps Terra when the previous automatic turn used Terra", () => {
  const result = routeGpt56Model({
    query: "それをさらに詳しく",
    previousModelId: TERRA_MODEL_ID,
  });
  assert.equal(result.modelId, TERRA_MODEL_ID);
  assert.match(result.reason, /会話の続き/);
});

test("automatic routing never selects Sol", () => {
  const cases = [
    {},
    { query: "短い質問" },
    { query: "包括的な要件定義とアーキテクチャ設計をして" },
    { format: "pptx" },
    { attachments: [{ name: "a" }, { name: "b" }] },
  ];
  for (const input of cases) {
    assert.notEqual(routeGpt56Model(input).modelId, "gpt-5.6-sol");
  }
});
