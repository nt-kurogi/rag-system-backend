import assert from "node:assert/strict";
import test from "node:test";

import { toRemoteFileInput } from "../src/lib/openai-input.js";

test("remote file input uses file_url without mutually exclusive filename", () => {
  const fileUrl =
    "https://example.blob.core.windows.net/chat-attachments/sample.xls?sig=test";
  const input = toRemoteFileInput(fileUrl);

  assert.deepEqual(input, {
    type: "input_file",
    file_url: fileUrl,
  });
  assert.equal(Object.hasOwn(input, "filename"), false);
  assert.equal(Object.hasOwn(input, "file_id"), false);
});

test("remote file input ignores an empty URL", () => {
  assert.equal(toRemoteFileInput("  "), null);
});
