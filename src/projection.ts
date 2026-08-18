/**
 * CodeShion-grade Multimodal to Text Projection Engine
 * 
 * Directly ports Shion's `_project_messages_for_target` and `_project_content_to_text`
 * with support for image placeholders, OCR metadata preservation, and MIME annotations.
 */

export interface ImageBlock {
  type: "image" | "input_image" | "image_url";
  source?: {
    type?: string;
    media_type?: string;
    data?: string;
  };
  image_url?: string | { url?: string };
  path?: string;
  mimeType?: string;
  caption?: string;
  text?: string;
  [key: string]: any;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id?: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
  [key: string]: any;
}

export interface TextBlock {
  type: "text";
  text: string;
  [key: string]: any;
}

export type ContentBlock = TextBlock | ImageBlock | ToolResultBlock | { type: string; [key: string]: any };

export interface Message {
  role: "system" | "user" | "assistant";
  content: string | ContentBlock[];
  source?: Record<string, any>;
  [key: string]: any;
}

export interface ProjectionOptions {
  /** Placeholder text format when image is projected to text */
  placeholderTemplate?: string;
  /** Whether to append caption/description if already present */
  preserveCaptions?: boolean;
  /** Custom filter to determine if a target model supports vision */
  visionModelMatcher?: (provider: string, model: string) => boolean;
}

export const DEFAULT_PLACEHOLDER = "[历史多模态图片：当前模型为纯文本模式，请根据上下文对话继续完成任务]";

/**
 * Modern Vision Detection (2025-2026+ Multimodal SOTA)
 * - Anthropic Claude: All Claude 3/3.5/3.7/4.x models support Vision by default.
 * - OpenAI: All GPT-4/4o/4.5/5 and o-series (o1, o3, o3-mini) support Vision.
 * - Google: All Gemini (1.5/2.0/2.5/3.0) and Gemma-Vision models support Vision.
 * - Moonshot AI / Kimi: Kimi k1.5, Kimi-Vision, Moonshot multimodal series.
 * - Open Source VLMs: Qwen2.5-VL, InternVL2.5/3, Pixtral, MiniCPM-V, GLM-4V, Llama-3.2-Vision.
 */
export function defaultSupportsVision(provider: string, model: string): boolean {
  const p = (provider || "").toLowerCase();
  const m = (model || "").toLowerCase();
  const full = `${p}/${m}`;

  // 1. Text-Only Exceptions (even within multimodal families or providers)
  if (m.includes("deepseek") && !m.includes("vl")) return false;
  if (m.includes("qwen") && !m.includes("vl") && !m.includes("vision")) return false;
  if (m.includes("llama-3-") && !m.includes("vision") && !m.includes("3.2")) return false;

  // 2. Claude series (Anthropic) - Claude 3+ are natively multimodal
  if (p.includes("anthropic") || p.includes("claude") || m.includes("claude")) return true;

  // 3. OpenAI series - GPT-4+, GPT-5+, o1/o3 reasoning models are multimodal
  if (p.includes("openai") || m.includes("gpt-4") || m.includes("gpt-5") || m.includes("o1") || m.includes("o3") || m.includes("o4")) {
    return true;
  }

  // 4. Google Gemini & Gemma
  if (p.includes("google") || p.includes("gemini") || m.includes("gemini") || m.includes("gemma-vision") || m.includes("paligemma")) {
    return true;
  }

  // 5. Moonshot / Kimi series (Kimi k1.5 / Moonshot Vision)
  if (p.includes("moonshot") || p.includes("kimi") || m.includes("kimi") || m.includes("k1.5")) {
    return true;
  }

  // 6. Open Source SOTA Vision-Language Models (VLMs)
  const vlmPatterns = [
    "vl", "vision", "vlm", "multimodal",
    "internvl", "pixtral", "minicpm", "glm-4v", "cogvlm", "llama-3.2"
  ];

  if (vlmPatterns.some(pattern => full.includes(pattern))) {
    return true;
  }

  return false;
}

export function isImageBlock(block: any): block is ImageBlock {
  if (!block || typeof block !== "object") return false;
  const t = block.type;
  return t === "image" || t === "input_image" || t === "image_url";
}

export function contentHasImage(content: string | ContentBlock[] | undefined | null): boolean {
  if (!content || typeof content === "string") return false;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (isImageBlock(block)) return true;
    if (block && block.type === "tool_result" && Array.isArray(block.content)) {
      return contentHasImage(block.content);
    }
    return false;
  });
}

export function messagesHaveImage(messages: Message[]): boolean {
  return messages.some((msg) => contentHasImage(msg.content));
}

/**
 * Deep, non-destructive projection of content blocks for text-only target models.
 * Converts image blocks into textual annotations while preserving surrounding text,
 * metadata, captions, and tool_result structures.
 */
export function projectContentForTarget(
  content: string | ContentBlock[],
  supportsVision: boolean,
  options: ProjectionOptions = {}
): string | ContentBlock[] {
  if (supportsVision) {
    return content;
  }

  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return content;
  }

  const placeholder = options.placeholderTemplate || DEFAULT_PLACEHOLDER;
  const preserveCaptions = options.preserveCaptions ?? true;

  const projectedBlocks: ContentBlock[] = [];

  for (const block of content) {
    if (isImageBlock(block)) {
      let desc = placeholder;
      if (preserveCaptions && block.caption) {
        desc = `[图片描述: ${block.caption}]`;
      } else if (preserveCaptions && block.text) {
        desc = `[图片文字: ${block.text}]`;
      }
      projectedBlocks.push({
        type: "text",
        text: desc
      });
    } else if (block && block.type === "tool_result" && Array.isArray(block.content)) {
      // Recursively project image blocks inside tool_result
      const projectedInner = projectContentForTarget(block.content, false, options);
      projectedBlocks.push({
        ...block,
        content: projectedInner
      });
    } else {
      projectedBlocks.push(block);
    }
  }

  // Merge consecutive text blocks if appropriate
  const compacted: ContentBlock[] = [];
  for (const block of projectedBlocks) {
    const last = compacted[compacted.length - 1];
    if (block.type === "text" && last && last.type === "text") {
      last.text = `${last.text}\n${(block as TextBlock).text}`.trim();
    } else {
      compacted.push(block);
    }
  }

  return compacted;
}

/**
 * 1:1 replica of CodeShion's `_project_messages_for_target`
 * Projects all session messages for the target model capabilities.
 */
export function projectMessagesForTarget(
  messages: Message[],
  supportsVision: boolean,
  options: ProjectionOptions = {}
): Message[] {
  if (supportsVision) {
    return messages;
  }

  return messages.map((message) => {
    if (!message.content) {
      return message;
    }
    const projectedContent = projectContentForTarget(message.content, false, options);
    return {
      ...message,
      content: projectedContent
    };
  });
}
