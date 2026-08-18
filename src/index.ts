import { Context, Service, Schema } from "cordis";
import {
  projectMessagesForTarget,
  projectContentForTarget,
  defaultSupportsVision,
  isImageBlock,
  contentHasImage,
  DEFAULT_PLACEHOLDER,
  type Message,
  type ProjectionOptions
} from "./projection.js";

export interface MultimodalBridgeConfig {
  /** Placeholder text inserted into message history when downgrading an image for a text-only model */
  placeholderTemplate?: string;
  /** Keep OCR annotations / captions if present in the block */
  preserveCaptions?: boolean;
  /** Extra comma-separated model names that should be treated as vision-capable */
  customVisionModels?: string[];
  /** Allow hot-switching to text-only models even when session contains images */
  bypassAdmissionLock?: boolean;
}

export const MultimodalBridgeConfig: Schema<MultimodalBridgeConfig> = Schema.object({
  placeholderTemplate: Schema.string().default(DEFAULT_PLACEHOLDER).description("多模态图像降级为纯文本时的占位说明"),
  preserveCaptions: Schema.boolean().default(true).description("保留图片已有的 OCR 或 Caption 标注文本"),
  customVisionModels: Schema.array(String).default([]).description("自定义额外支持 Vision 的模型标识列表"),
  bypassAdmissionLock: Schema.boolean().default(true).description("自动解除 DSH 官方对纯文本模型选取的死锁限制")
});

export class MultimodalBridgeService extends Service {
  static readonly Config = MultimodalBridgeConfig;
  static readonly schema = MultimodalBridgeConfig;
  static readonly inject = ["llm"];

  private unpatchers: (() => void)[] = [];

  constructor(ctx: Context, public config: MultimodalBridgeConfig) {
    super(ctx, "multimodal-bridge", true);
  }

  public install() {
    this.installLlmInterceptor();
    if (this.ctx?.logger) {
      this.ctx.logger.info("Multimodal Bridge plugin started: Vision-to-Text dynamic projection enabled.");
    }
  }

  public uninstall() {
    // Reverse unpatching (LIFO stack) to preserve correct monkey-patching chain
    while (this.unpatchers.length > 0) {
      const unpatch = this.unpatchers.pop();
      try {
        unpatch?.();
      } catch (err) {
        if (this.ctx?.logger) {
          this.ctx.logger.warn(`Failed to revert patch: ${String(err)}`);
        }
      }
    }
    if (this.ctx?.logger) {
      this.ctx.logger.info("Multimodal Bridge plugin stopped: patches reverted.");
    }
  }

  protected override start() {
    this.install();
  }

  protected override stop() {
    this.uninstall();
  }

  /**
   * Check if a target model supports vision input
   */
  public supportsVision(provider: string, model: string): boolean {
    const custom = this.config.customVisionModels || [];
    const target = `${provider}/${model}`.toLowerCase();
    if (custom.some(c => target.includes(c.toLowerCase()))) {
      return true;
    }
    return defaultSupportsVision(provider, model);
  }

  /**
   * Project a list of messages for a given target model
   */
  public projectMessages(messages: Message[], provider: string, model: string): Message[] {
    const isVision = this.supportsVision(provider, model);
    return projectMessagesForTarget(messages, isVision, {
      placeholderTemplate: this.config.placeholderTemplate,
      preserveCaptions: this.config.preserveCaptions
    });
  }

  private installLlmInterceptor() {
    const llm = (this.ctx as any)?.llm;
    if (!llm) return;

    // 1. Hook llm.stream to dynamically project messages right before LLM dispatch
    if (typeof llm.stream === "function") {
      const originalStream = llm.stream.bind(llm);
      const patchedStream = (options: any) => {
        if (options && Array.isArray(options.messages)) {
          const provider = options.provider || "";
          const model = options.model || "";
          const isVision = this.supportsVision(provider, model);

          if (!isVision && options.messages.some((m: any) => contentHasImage(m.content))) {
            const projected = projectMessagesForTarget(options.messages, false, {
              placeholderTemplate: this.config.placeholderTemplate,
              preserveCaptions: this.config.preserveCaptions
            });
            options = {
              ...options,
              messages: projected
            };
          }
        }
        return originalStream(options);
      };

      llm.stream = patchedStream;
      this.unpatchers.push(() => {
        llm.stream = originalStream;
      });
    }

    // 2. Hook prepareCall if present
    if (typeof llm.prepareCall === "function") {
      const originalPrepareCall = llm.prepareCall.bind(llm);
      const patchedPrepareCall = async (config: any, signal?: any) => {
        const prepared = await originalPrepareCall(config, signal);
        if (prepared && typeof prepared.stream === "function") {
          const origPreparedStream = prepared.stream.bind(prepared);
          prepared.stream = (options: any) => {
            if (options && Array.isArray(options.messages)) {
              const provider = options.provider || config.provider || "";
              const model = options.model || config.model || "";
              const isVision = this.supportsVision(provider, model);

              if (!isVision && options.messages.some((m: any) => contentHasImage(m.content))) {
                const projected = projectMessagesForTarget(options.messages, false, {
                  placeholderTemplate: this.config.placeholderTemplate,
                  preserveCaptions: this.config.preserveCaptions
                });
                options = {
                  ...options,
                  messages: projected
                };
              }
            }
            return origPreparedStream(options);
          };
        }
        return prepared;
      };

      llm.prepareCall = patchedPrepareCall;
      this.unpatchers.push(() => {
        llm.prepareCall = originalPrepareCall;
      });
    }

    // 3. Patch resolveModelInfo to gracefully allow image admission when bypassAdmissionLock is true
    if (typeof llm.resolveModelInfo === "function" && this.config.bypassAdmissionLock) {
      const origResolveModelInfo = llm.resolveModelInfo.bind(llm);
      const patchedResolveModelInfo = async (provider: string, model: string, signal?: any) => {
        const info = await origResolveModelInfo(provider, model, signal);
        if (info && Array.isArray(info.inputModalities)) {
          if (!info.inputModalities.includes("image")) {
            return {
              ...info,
              inputModalities: [...info.inputModalities, "image"]
            };
          }
        }
        return info;
      };

      llm.resolveModelInfo = patchedResolveModelInfo;
      this.unpatchers.push(() => {
        llm.resolveModelInfo = origResolveModelInfo;
      });
    }
  }
}

export default MultimodalBridgeService;
export { projectMessagesForTarget, projectContentForTarget, defaultSupportsVision } from "./projection.js";
