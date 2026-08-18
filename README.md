# @shion-lab/dsh-plugin-multimodal-bridge

> **1:1 CodeShion (紫苑) 动态多模态降级与跨模型自由热切换引擎**  
> 专为 DeepSeek Harness (`dsh`) 打造的无死锁跨模型视觉桥接插件。

---

## 解决的核心痛点

在 DSH 原生环境下：
- 当你在会话中发送了一张图片（例如借助 Gemini / Claude 进行视觉分析）；
- 之后如果想切换回纯文本模型（例如 **DeepSeek-V4 / DeepSeek-V3 / DeepSeek-Coder**）；
- DSH 官方服务会直接抛出死锁错误并拒绝切模型：
  > `Model "deepseek-v4" does not accept image input, but this session already contains images; select an image-capable model.`

**`dsh-plugin-multimodal-bridge`** 完美复刻了 **CodeShion（紫苑）** 的底层动态视口投影设计：
1. **多模态模型（Gemini / Claude / GPT-4o）**：透传真实二进制与多模态块，享受完整视觉能力；
2. **纯文本模型（DeepSeek / Llama 等）**：在调用模型前的一瞬间，自动将历史多模态图片块平滑降级为 `[图片内容：历史多模态图像...]` 或 OCR 描述文本；
3. **解除死锁**：完全放行模型切换，历史上下文永不丢失，自由在视觉模型与 DeepSeek 之间热切换！

---

## 安装

```bash
npm install -g @shion-lab/dsh-plugin-multimodal-bridge
```

---

## 配置项 (Cordis Schema)

| 配置项 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `placeholderTemplate` | `string` | `[图片内容：历史多模态图像...]` | 降级为纯文本时的占位说明文本 |
| `preserveCaptions` | `boolean` | `true` | 若图片带有已提取的 Caption/OCR 描述，优先保留真实文字内容 |
| `bypassAdmissionLock` | `boolean` | `true` | 自动解除 DSH 官方对于纯文本模型选取的死锁报错 |
| `customVisionModels` | `string[]` | `[]` | 自定义额外的 Vision 模型关键字匹配列表 |

---

## 开源协议

MIT License (c) 2026 Shion Lab
