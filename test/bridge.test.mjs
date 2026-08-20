import assert from "node:assert/strict";
import { Context } from "cordis";
import {
  projectContentForTarget,
  projectMessagesForTarget,
  defaultSupportsVision,
  contentHasImage,
  messagesHaveImage,
  DEFAULT_PLACEHOLDER
} from "../dist/projection.js";
import { MultimodalBridgeService, MultimodalBridgeConfig } from "../dist/index.js";

console.log("Running Multimodal Bridge Unit Tests...");

// Test 1: Model Detection
assert.equal(defaultSupportsVision("google", "gemini-2.5-pro"), true);
assert.equal(defaultSupportsVision("google", "gemini-3.0-flash"), true);
assert.equal(defaultSupportsVision("anthropic", "claude-3-7-sonnet"), true);
assert.equal(defaultSupportsVision("anthropic", "claude-4-opus"), true);
assert.equal(defaultSupportsVision("openai", "gpt-4.5-preview"), true);
assert.equal(defaultSupportsVision("openai", "gpt-5"), true);
assert.equal(defaultSupportsVision("openai", "o3"), true);
assert.equal(defaultSupportsVision("openai", "o3-mini"), true);
assert.equal(defaultSupportsVision("alibaba", "qwen2.5-vl-72b-instruct"), true);
assert.equal(defaultSupportsVision("opengvlab", "internvl2.5-8b"), true);
assert.equal(defaultSupportsVision("mistralai", "pixtral-12b"), true);
assert.equal(defaultSupportsVision("openbmb", "minicpm-v-2_6"), true);
assert.equal(defaultSupportsVision("zhipu", "glm-4v-plus"), true);
assert.equal(defaultSupportsVision("meta", "llama-3.2-11b-vision-instruct"), true);

// Text-only negative assertions
assert.equal(defaultSupportsVision("deepseek", "deepseek-v3"), false);
assert.equal(defaultSupportsVision("deepseek", "deepseek-v4-flash"), false);
assert.equal(defaultSupportsVision("deepseek", "deepseek-coder"), false);
assert.equal(defaultSupportsVision("meta", "llama-3.3-70b-instruct"), false);
assert.equal(defaultSupportsVision("alibaba", "qwen-2.5-72b-instruct"), false);
console.log("✔ Model Detection passed (2025-2026 Latest SOTA VLMs covered)");

// Test 2: Image Detection (including recursive tool_result)
const textOnly = [{ type: "text", text: "hello world" }];
const withImage = [
  { type: "text", text: "Look at this:" },
  { type: "image", source: { media_type: "image/png", data: "base64..." } }
];
const withImageUrl = [
  { type: "image_url", image_url: { url: "https://example.com/test.png" } }
];
const withToolResultImage = [
  {
    type: "tool_result",
    tool_use_id: "call_123",
    content: [
      { type: "text", text: "Screenshot captured:" },
      { type: "image", source: { data: "tool_image_base64" } }
    ]
  }
];

assert.equal(contentHasImage("just text"), false);
assert.equal(contentHasImage(textOnly), false);
assert.equal(contentHasImage(withImage), true);
assert.equal(contentHasImage(withImageUrl), true);
assert.equal(contentHasImage(withToolResultImage), true);

const msgs = [
  { role: "user", content: textOnly },
  { role: "assistant", content: "ok" },
  { role: "tool", content: withToolResultImage }
];
assert.equal(messagesHaveImage(msgs), true);
console.log("✔ Image Detection (with recursive tool_result) passed");

// Test 3: Preserve Vision for Gemini/Claude
const content = [
  { type: "text", text: "Here is an image:" },
  { type: "image", source: { data: "raw_image_data" } }
];

const result = projectContentForTarget(content, true);
assert.deepEqual(result, content);
console.log("✔ Preserve Vision passed");

// Test 4: Project to Text for DeepSeek
const contentToProject = [
  { type: "text", text: "User prompt before image." },
  { type: "image", source: { data: "base64" } },
  { type: "text", text: "User prompt after image." }
];

const projResult = projectContentForTarget(contentToProject, false);
assert.equal(Array.isArray(projResult), true);
assert.equal(projResult.length, 1);
assert.ok(projResult[0].text.includes("User prompt before image."));
assert.ok(projResult[0].text.includes(DEFAULT_PLACEHOLDER));
assert.ok(projResult[0].text.includes("User prompt after image."));
console.log("✔ Project to Text passed");

// Test 5: Preserve Captions
const captionContent = [
  {
    type: "image",
    caption: "A diagram showing system architecture with 3 microservices.",
    source: { data: "base64" }
  }
];

const captionResult = projectContentForTarget(captionContent, false, { preserveCaptions: true });
assert.equal(captionResult.length, 1);
assert.ok(captionResult[0].text.includes("[图片描述: A diagram showing system architecture with 3 microservices.]"));
console.log("✔ Preserve Captions passed");

// Test 6: Full Session History Hot-Switching
const sessionHistory = [
  {
    role: "user",
    content: [
      { type: "text", text: "Check this screenshot:" },
      { type: "image", source: { data: "xyz" } }
    ]
  },
  {
    role: "assistant",
    content: "I see the screenshot shows an error in line 42."
  },
  {
    role: "user",
    content: "Can you fix it?"
  }
];

// 1. To Gemini -> full vision unchanged
const geminiMessages = projectMessagesForTarget(sessionHistory, true);
assert.deepEqual(geminiMessages, sessionHistory);

// 2. Hot-switch to DeepSeek -> projected seamlessly
const deepseekMessages = projectMessagesForTarget(sessionHistory, false);
assert.equal(deepseekMessages.length, 3);
assert.equal(deepseekMessages[0].content[0].type, "text");
assert.ok(deepseekMessages[0].content[0].text.includes(DEFAULT_PLACEHOLDER));
assert.equal(deepseekMessages[1].content, "I see the screenshot shows an error in line 42.");
assert.equal(deepseekMessages[2].content, "Can you fix it?");
console.log("✔ Full Session History Hot-Switching passed");

// Test 7: Cordis Config Schema & Defaults
const config = MultimodalBridgeConfig({});
assert.equal(config.bypassAdmissionLock, true);
assert.equal(config.preserveCaptions, true);
assert.equal(config.placeholderTemplate, DEFAULT_PLACEHOLDER);
console.log("✔ Cordis Config Schema & Defaults passed");

// Test 8: Cordis Service Interception & Unpatch Lifecycle
async function testCordisLifecycle() {
  let interceptedOptions = null;
  const mockLlm = {
    async *stream(options) {
      interceptedOptions = options;
      yield { type: "text", text: "DeepSeek response" };
    },
    async resolveModelInfo(provider, model) {
      return {
        provider,
        model,
        inputModalities: ["text"]
      };
    }
  };

  const app = new Context();
  app.llm = mockLlm;

  const service = new MultimodalBridgeService(app, {
    bypassAdmissionLock: true,
    preserveCaptions: true,
    placeholderTemplate: DEFAULT_PLACEHOLDER,
    customVisionModels: []
  });

  service.install();

  // 1. Test admission bypass
  const info = await mockLlm.resolveModelInfo("deepseek", "deepseek-v3");
  assert.ok(info.inputModalities.includes("image"), "Should synthesize image modality for admission bypass");

  // 2. Test stream interception
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "Look:" },
        { type: "image", source: { data: "img" } }
      ]
    }
  ];

  const iterator = mockLlm.stream({
    provider: "deepseek",
    model: "deepseek-v3",
    messages
  });

  for await (const chunk of iterator) {
    assert.equal(chunk.text, "DeepSeek response");
  }

  assert.ok(interceptedOptions != null);
  assert.equal(interceptedOptions.messages[0].content[0].type, "text");
  assert.ok(interceptedOptions.messages[0].content[0].text.includes(DEFAULT_PLACEHOLDER));

  // 3. Test stop & unpatch
  service.uninstall();
  const restoredInfo = await mockLlm.resolveModelInfo("deepseek", "deepseek-v3");
  assert.deepEqual(restoredInfo.inputModalities, ["text"]);
  console.log("✔ Cordis Service Interception & Unpatch Lifecycle passed");
}

// Test 9: Read-only / Frozen Object Protection Test
async function testReadOnlyProtection() {
  const frozenPrepared = Object.freeze({
    stream(options) {
      return "original stream";
    }
  });

  const mockLlm = {
    async prepareCall(config) {
      return frozenPrepared;
    }
  };

  const app = new Context();
  app.llm = mockLlm;

  const service = new MultimodalBridgeService(app, {});
  service.install();

  // Call prepareCall on frozen object - should return proxy without throwing Cannot assign to read only property 'stream'
  const prepared = await mockLlm.prepareCall({});
  assert.ok(typeof prepared.stream === "function");
  const res = prepared.stream({});
  assert.equal(res, "original stream");
  console.log("✔ Read-only / Frozen Object Protection passed");
}

await testCordisLifecycle();
await testReadOnlyProtection();
console.log("\nALL 9 MULTIMODAL BRIDGE TEST SUITES PASSED! 🎉");
