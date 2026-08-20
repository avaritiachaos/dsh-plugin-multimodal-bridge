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

  constructor(ctx: Context, public config: MultimodalBridgeConfig = {}) {
    super(ctx, "multimodal-bridge", true);
    this.install();
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

    const self = this;

    // Collect all targets in prototype chain + target instance itself to cover:
    // (1) Mock plain objects in unit tests (`{ resolveModelInfo: ... }`)
    // (2) Cordis Service Proxy instances in live DSH (`llm.constructor.prototype` & `Object.getPrototypeOf(llm)`)
    const targets: any[] = [];
    if (llm) targets.push(llm);

    const proto = Object.getPrototypeOf(llm);
    if (proto && proto !== Object.prototype) {
      targets.push(proto);
    }
    if (llm.constructor?.prototype && llm.constructor.prototype !== Object.prototype && !targets.includes(llm.constructor.prototype)) {
      targets.push(llm.constructor.prototype);
    }

    const patchMethodOnObject = (
      obj: any,
      prop: string,
      wrapperFactory: (origMethod: Function) => Function
    ) => {
      if (!obj) return;
      let original: any;
      try {
        original = obj[prop];
      } catch {
        return;
      }
      if (typeof original !== "function") return;
      const wrapped = wrapperFactory(original);

      let patched = false;
      try {
        obj[prop] = wrapped;
        patched = true;
      } catch {
        try {
          const desc = Object.getOwnPropertyDescriptor(obj, prop);
          Object.defineProperty(obj, prop, {
            configurable: true,
            writable: true,
            enumerable: desc ? desc.enumerable : true,
            value: wrapped,
          });
          patched = true;
        } catch {
          const p = Object.getPrototypeOf(obj);
          if (p && p !== Object.prototype) {
            try {
              const pDesc = Object.getOwnPropertyDescriptor(p, prop);
              Object.defineProperty(p, prop, {
                configurable: true,
                writable: true,
                enumerable: pDesc ? pDesc.enumerable : true,
                value: wrapped,
              });
              patched = true;
            } catch {
              // ignore
            }
          }
        }
      }

      if (patched) {
        self.unpatchers.push(() => {
          try {
            obj[prop] = original;
          } catch {
            try {
              Object.defineProperty(obj, prop, { value: original });
            } catch {
              // ignore
            }
          }
        });
      }
    };

    for (const target of targets) {
      // 1. Hook stream
      patchMethodOnObject(target, "stream", (originalStream) => {
        return function(this: any, options: any) {
          if (options && Array.isArray(options.messages)) {
            const provider = options.provider || "";
            const model = options.model || "";
            const isVision = self.supportsVision(provider, model);

            if (!isVision && options.messages.some((m: any) => contentHasImage(m.content))) {
              const projected = projectMessagesForTarget(options.messages, false, {
                placeholderTemplate: self.config.placeholderTemplate,
                preserveCaptions: self.config.preserveCaptions
              });
              options = {
                ...options,
                messages: projected
              };
            }
          }
          return originalStream.call(this, options);
        };
      });

      // 2. Hook prepareCall if present
      patchMethodOnObject(target, "prepareCall", (originalPrepareCall) => {
        return async function(this: any, config: any, signal?: any) {
          const prepared = await originalPrepareCall.call(this, config, signal);
          if (prepared && typeof prepared.stream === "function") {
            const origPreparedStream = prepared.stream;
            const wrappedPreparedStream = function(this: any, options: any) {
              if (options && Array.isArray(options.messages)) {
                const provider = options.provider || config?.provider || "";
                const model = options.model || config?.model || "";
                const isVision = self.supportsVision(provider, model);

                if (!isVision && options.messages.some((m: any) => contentHasImage(m.content))) {
                  const projected = projectMessagesForTarget(options.messages, false, {
                    placeholderTemplate: self.config.placeholderTemplate,
                    preserveCaptions: self.config.preserveCaptions
                  });
                  options = {
                    ...options,
                    messages: projected
                  };
                }
              }
              return origPreparedStream.call(this, options);
            };

            // Try direct mutation or defineProperty first
            try {
              prepared.stream = wrappedPreparedStream;
              return prepared;
            } catch {
              try {
                const desc = Object.getOwnPropertyDescriptor(prepared, "stream");
                Object.defineProperty(prepared, "stream", {
                  configurable: true,
                  writable: true,
                  enumerable: desc ? desc.enumerable : true,
                  value: wrappedPreparedStream,
                });
                return prepared;
              } catch {
                // Target is frozen/read-only: use Proxy with an empty object target to avoid Proxy Invariants
                return new Proxy({}, {
                  get(_t, prop, receiver) {
                    if (prop === "stream") return wrappedPreparedStream;
                    const val = Reflect.get(prepared, prop);
                    return typeof val === "function" ? val.bind(prepared) : val;
                  },
                  has(_t, prop) {
                    if (prop === "stream") return true;
                    return prop in prepared;
                  }
                });
              }
            }
          }
          return prepared;
        };
      });

      // 3. Patch resolveModelInfo if present
      if (this.config.bypassAdmissionLock ?? true) {
        patchMethodOnObject(target, "resolveModelInfo", (origResolveModelInfo) => {
          return async function(this: any, provider: string, model: string, signal?: any) {
            const info = await origResolveModelInfo.call(this, provider, model, signal);
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
        });
      }
    }
  }
}

(MultimodalBridgeService as any)[Symbol.for("cordis.provide")] = "multimodal-bridge";

export default MultimodalBridgeService;
export { projectMessagesForTarget, projectContentForTarget, defaultSupportsVision } from "./projection.js";
