# AI 服务集成说明

> 赛题 A 硬性要求：明确说明所用 AI 服务、调用方式与集成位置。本文只写**当前实际运行**的实现，不做能力夸大。

## 1. 用了什么

| 项 | 值 |
|---|---|
| 服务商 | 火山方舟（当前演示）/ 小米 MiMo（默认兼容） |
| 协议 | OpenAI 兼容 Chat Completions（`POST {LLM_ENDPOINT}/chat/completions`） |
| 默认端点 | `https://ark.cn-beijing.volces.com/api/v3`（当前演示）/ `https://api.xiaomimimo.com/v1`（默认兼容） |
| 默认模型 | `doubao-seed-2-1-lite`（当前演示）/ `mimo-v2.6-flash`（默认兼容） |
| 鉴权 | `Authorization: Bearer $LLM_API_KEY` |
| 调用参数 | `temperature=0.2`、`max_completion_tokens=800`（推理模型被截断时自动放大重试）、`stream=false` |
| 超时 | `LLM_TIMEOUT_MS`，默认 15000ms |
| 新增依赖 | **零**（Node 内置 `fetch` + `AbortSignal.timeout`） |

选它的原因：OpenAI 兼容协议让「换一家模型」只改 `LLM_ENDPOINT` + `LLM_MODEL`，不需要改代码；flash 档延迟与成本都适合做**每条入站消息都跑一次**的意图识别。

## 2. 调用方式

System 提示词固定为「只输出一个 JSON 对象」，字段与约束：

```json
{ "intent": "待办|咨询|通知|未分类", "confidence": 0.93, "summary": "40 字内摘要", "replyDraft": "一句可直接发送的回复" }
```

服务端对模型输出做**严格校验**：只有「调用失败 / 结构不合法」才不采用；**置信度低不丢弃结果**，只划分精度档。

| 校验 | 不满足时 |
|---|---|
| 去掉 markdown 围栏后能被 `JSON.parse` | 回退规则识别，`fallbackReason=invalid_json` |
| `intent` ∈ {待办, 咨询, 通知, 未分类} | 回退，`invalid_intent` |
| `confidence` ∈ [0,1] | 回退，`invalid_confidence` |
| `summary` / `replyDraft` 非空 | 回退，`missing_fields` |
| `confidence ≥ LLM_MIN_CONFIDENCE`（默认 0.6） | **不回退**：仍采用模型结果，标 `aiPrecision='low'`，界面提示「信息量较少 · 精度较低」。阈值现在是精度分档线，不是「是否采用」的开关 |
| 非 2xx | 回退，`http_<code>`（附服务商响应摘要） |
| 2xx 且 `choices[0].message.content` 非空 | 否则回退，`empty_content` |
| 在 `LLM_TIMEOUT_MS` 内返回 | 回退，`timeout` |
| 429 / 503 | 按 `Retry-After` 重试 **1 次**，仍失败则回退 |
| `content` 为空且 `finish_reason=length` | 放大输出预算重试 **1 次**（推理模型思维链耗尽预算），仍空则回退 |

**绝不静默假装成功**：只有真实调用失败时消息才带 `intentSource='rules'`、界面显示「规则兜底」；真实模型结果带 `intentSource='llm'` 与 `aiProvider` / `aiModel`（本次生效的厂商显示名与模型 ID），界面据此动态显示「火山方舟 识别」/「MiMo 识别」等，**不再固定写 MiMo**；历史消息保留当时的值，配置换了也不会被回溯改写。

**任何消息都有 AI 建议**：模型只要成功响应（HTTP 200 + 合法 JSON），哪怕 `confidence=0.3` 判「未分类」，也照常采用它的意图、摘要与草稿 —— 差异只体现在**长短与精度**上。System 提示词要求模型按信息量自适应：信息充分时给针对性强的完整回复，信息不足时给一句不超过 25 字的澄清追问、不编造事实。消息额外记录 `aiConfidence` / `aiPrecision`（`high` / `low`），低精度时前端显示温和提示「信息量较少 · 模型把握 30%，草稿偏简短、精度较低」，并写一条 `intent_low_precision` 闭环日志（**不是** `intent_fallback`）。这样既不会把已生成的 AI 建议丢掉换成关键词规则，也不会把低把握结果伪装成高置信。闭环日志同步记录 `intent ... via <provider>/<model> <ms> <tok>`；非 2xx 还会带上服务商响应体摘要（截断 180 字、不含密钥），便于直接定位「模型 ID 不存在 / 模型未开通」。

## 3. 集成位置

| 文件 | 职责 |
|---|---|
| `packages/server/src/config/runtime.ts` → `resolveLlmRuntime()` | 环境变量 → 运行模式（`real` / `mock`）的纯函数，给出 `ready / missing / reason`，与平台连接器同一套可替换性规则 |
| `packages/server/src/config.ts` | 读取 `LLM_*`；单测环境强制 `mock`，测试绝不出网 |
| `packages/server/src/services/llm.ts` | 适配器：组装请求（信息量自适应提示词、火山方舟自动关深度思考）、超时、重试、输出预算放大、JSON 校验、精度分档、真实失败才规则兜底 |
| `packages/server/src/services/message.ts` → `enrich()` / `analyzeAndApply()` | 入库后异步富化：写 `intent` / `replyDraft` / `intentSource` / `aiProvider` / `aiModel` / `aiConfidence` / `aiPrecision`，补广播 `message.updated`；低精度写 `intent_low_precision` 日志 |
| `packages/server/src/services/message.ts` → `reanalyze()` | 详情页「重新生成」：用当前配置重算历史消息，不重跑 OCR、不改业务状态，写 `reanalyze_requested` / `reanalyze_done` 闭环日志；并发去重 |
| `packages/server/src/routes/messages.ts` | `POST /api/messages/:id/reanalyze` 返回完整消息 + `llm{mode,reason,providerLabel,precision,confidence}`，区分「调用失败回退」与「低精度但已采用」，密钥不出服务端 |
| `packages/server/src/doctor/probes.ts` → `probeLlm()` | 自检探针：一条固定样例走真实调用，报告 PASS/FAIL、延迟、模型名（Key 不落日志）；404 给出「模型 ID / 未开通」指引 |
| `packages/shared/src/message.ts` | 契约含 `intentSource?: 'llm' \| 'rules'`、`aiProvider?` / `aiModel?` / `aiConfidence?` / `aiPrecision?` |
| `packages/web/src/features/inbox/AiSuggestion.tsx` | 详情页按 `aiProvider` 动态标注厂商或「规则兜底」；低精度显示「信息量较少」提示（不冒充规则兜底）；「重新生成」按钮带 loading |
| `packages/web/src/features/inbox/DetailPanel.tsx` → `handleRegenerate()` | 成功（含低精度）只就地刷新面板、不弹浮层；仅规则兜底 / 调用失败时短暂提示后端 `llm.reason` |
| `packages/web/src/app/ThemeProvider.tsx` + `styles/app.css` | 全局 message 默认 `duration=2.4s`、`maxCount=2`，固定在顶栏下方右侧，避免压住底部「发送」按钮 |

## 4. 数据流

```
平台 Webhook / IMAP 轮询
        │
        ▼
 ingest()  保存 → 写 received 日志 → 立即广播 message.received  ← 不等待 AI
        │
        └─(后台)─▶ enrich()
                     ├─ OCR（占位）
                     └─ LlmService.analyze()  ── 真实调用 ──▶ 模型
                              │ 成功（含低置信）      │ 失败 / 超时 / 响应不合法
                              ▼                      ▼
                        intentSource='llm'      intentSource='rules'
                        ├─ aiPrecision=high        规则兜底 + intent_fallback 日志
                        └─ aiPrecision=low
                           （仍用模型草稿，只更短 / 低精度提示）
                              └──────┬───────────────┘
                                     ▼
                     写 trace + 广播 message.updated（前端就地刷新）
```

为什么异步：真实调用通常 3–9s（长尾接近 9s）。同步等待会让 Webhook 响应被拖住（平台超时会重推）并让收件箱迟迟不出新消息。

## 5. 配置与替换

```bash
# .env（不会进仓库）
LLM_PROVIDER=openai
LLM_API_KEY=sk-...
LLM_MODEL=mimo-v2.6-flash
LLM_ENDPOINT=https://api.xiaomimimo.com/v1
LLM_TIMEOUT_MS=15000
LLM_MIN_CONFIDENCE=0.6
```

换其他 OpenAI 兼容服务商只改两行（`LLM_ENDPOINT` + `LLM_MODEL`）：

| 服务商 | `LLM_ENDPOINT` | 模型 ID 示例 |
|---|---|---|
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| 火山方舟 | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seed-1-6-250615` |

**六个最容易踩的坑**（按出现频率排序）：

1. **`LLM_PROVIDER` 填的是协议类型，不是厂商中文名**。火山方舟 / DeepSeek / 通义 / 智谱 / MiMo 都是 OpenAI 兼容协议，一律 `openai`；厂商靠 `LLM_ENDPOINT` 推断。页面填「火山引擎」「deepseek」等也会自动归一到 `openai`，但填「wenxin」这类非兼容服务仍会显式降级为规则识别，不会静默假装成功。
2. **`LLM_MODEL` 必须是控制台里的「模型 ID」，不是显示名**，且该模型必须已在服务商控制台**开通/激活**。例如填 `Doubao-Seed-2.1-lite` 会得到 `http_404: The model or endpoint ... does not exist`；填了正确 ID 但没开通会得到 `Your account has not activated the model ...`。两种情况的响应体摘要都会写进闭环日志与 `pnpm run doctor` 的建议里。
3. **页面「API Base URL」写进 `LLM_ENDPOINT`**（旧版写的是兼容别名 `LLM_BASE_URL`，服务端两个键都读、前者优先）。页面上改完**必须重启后端**，配置只在启动时解析；`.env` 里显式写过的值页面改不动，会列进 `ignoredByEnv`。
4. **历史消息不会自动重算**：AI 分析原本只在消息入库时跑一次。改完配置后，在消息详情页点「**重新生成**」即可用当前配置重跑（或直接发一条新消息）。成功后草稿、来源标签、低精度说明在 AI 面板里就地刷新，**不弹浮层**（toast 会遮住底部「发送」按钮，且信息重复）；只有规则兜底 / 调用失败才短暂提示，并带上后端 `llm.reason` 说明原因。
5. **推理模型会「什么都不返回」**：豆包 `doubao-seed-*` 等带深度思考的模型，默认把 `max_completion_tokens` 全部花在思维链上，响应是 `content: ""` + `finish_reason: "length"` + `usage.completion_tokens_details.reasoning_tokens`，看起来像配置错了，实际 HTTP 是 200。服务端已对「火山端点 + 豆包模型」自动加 `thinking: {"type":"disabled"}`（关掉思考后从 400 token 空正文变成几十 token 的合法 JSON），并在任何推理模型被 `length` 截断时自动把输出预算放大 3 倍重试一次；仍然为空才回退，且 `empty_content` 原因里会带上 `finish_reason` / `reasoning_tokens` 便于定位。`response_format: json_object` 对此无效，不要拿它当解法。
6. **短消息也一定有 AI 建议**：模型对 `"1"` 给 `confidence=0.3` / `intent=未分类` / `replyDraft=您好，请问您有什么具体需求可以详细说明一下吗？`，对明确业务消息（周报 / 通知 / 咨询）给 `0.95~0.99` 和针对性回复——**它本来就能生成，只是长短和精度不同**。低置信结果不再丢弃换成关键词规则，一律采用模型结果：低精度时草稿更简短、界面提示「信息量较少 · 精度较低」，`LLM_MIN_CONFIDENCE=0.6` 只是精度分档线。看到「低精度」不要当成 API / Key 坏了去排查；只有界面出现「规则兜底」才代表真实调用失败（超时 / 404 / 网络 / 畸形 JSON）。

不填 Key / `LLM_PROVIDER=mock` → 走内置规则识别，零密钥也能完整演示；`pnpm run doctor` 会明确给出 SKIP 与启用步骤，真实调用失败则给 FAIL + 可操作建议。

## 6. 安全与成本

- Key 只在服务端读取，不写日志、不进前端 bundle、不进 doctor 报告（探针只报模型名与延迟）。
- `.env` 已被 `.gitignore` 忽略；交付包由 `git archive` 生成，天然不含凭据。
- 成本：flash 单条约 150–340 tokens，按每条入站消息一次调用估算，日常演示量级成本可忽略。
- 限流：429/503 重试一次后回退规则，不阻塞消息入库。
