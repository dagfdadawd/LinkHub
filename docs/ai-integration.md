# AI 服务集成说明

> 赛题 A 硬性要求：明确说明所用 AI 服务、调用方式与集成位置。本文只写**当前实际运行**的实现，不做能力夸大。

## 1. 用了什么

| 项 | 值 |
|---|---|
| 服务商 | 小米 MiMo 开放平台 |
| 协议 | OpenAI 兼容 Chat Completions（`POST {LLM_ENDPOINT}/chat/completions`） |
| 默认端点 | `https://api.xiaomimimo.com/v1` |
| 默认模型 | `mimo-v2.6-flash` |
| 鉴权 | `Authorization: Bearer $LLM_API_KEY` |
| 调用参数 | `temperature=0.2`、`max_completion_tokens=400`、`stream=false` |
| 超时 | `LLM_TIMEOUT_MS`，默认 15000ms |
| 新增依赖 | **零**（Node 内置 `fetch` + `AbortSignal.timeout`） |

选它的原因：OpenAI 兼容协议让「换一家模型」只改 `LLM_ENDPOINT` + `LLM_MODEL`，不需要改代码；flash 档延迟与成本都适合做**每条入站消息都跑一次**的意图识别。

## 2. 调用方式

System 提示词固定为「只输出一个 JSON 对象」，字段与约束：

```json
{ "intent": "待办|咨询|通知|未分类", "confidence": 0.93, "summary": "40 字内摘要", "replyDraft": "一句可直接发送的回复" }
```

服务端对模型输出做**严格校验**，任何一项不满足都不采用：

| 校验 | 不满足时 |
|---|---|
| 去掉 markdown 围栏后能被 `JSON.parse` | 回退规则识别，`fallbackReason=invalid_json` |
| `intent` ∈ {待办, 咨询, 通知, 未分类} | 回退，`invalid_intent` |
| `confidence` ∈ [0,1] | 回退，`invalid_confidence` |
| `summary` / `replyDraft` 非空 | 回退，`missing_fields` |
| `confidence ≥ LLM_MIN_CONFIDENCE`（默认 0.6） | 回退，`low_confidence` |
| HTTP 2xx 且非空 content | 回退，`http_<code>` / `empty_content` |
| 在 `LLM_TIMEOUT_MS` 内返回 | 回退，`timeout` |
| 429 / 503 | 按 `Retry-After` 重试 **1 次**，仍失败则回退 |

**绝不静默假装成功**：回退时消息会带 `intentSource='rules'`，界面显示「规则兜底」；真实模型结果带 `intentSource='llm'`，界面显示「MiMo 识别」。闭环日志同步记录 `intent ... via mimo/mimo-v2.6-flash <ms> <tok>`。

## 3. 集成位置

| 文件 | 职责 |
|---|---|
| `packages/server/src/config/runtime.ts` → `resolveLlmRuntime()` | 环境变量 → 运行模式（`real` / `mock`）的纯函数，给出 `ready / missing / reason`，与平台连接器同一套可替换性规则 |
| `packages/server/src/config.ts` | 读取 `LLM_*`；单测环境强制 `mock`，测试绝不出网 |
| `packages/server/src/services/llm.ts` | 适配器：组装请求、超时、重试、JSON 校验、低置信降级、规则兜底 |
| `packages/server/src/services/message.ts` → `enrich()` | 入库后异步富化：写 `intent` / `replyDraft` / `intentSource`，补广播 `message.updated` |
| `packages/server/src/doctor/probes.ts` → `probeLlm()` | 自检探针：一条固定样例走真实调用，报告 PASS/FAIL、延迟、模型名（Key 不落日志） |
| `packages/shared/src/message.ts` | 契约新增 `intentSource?: 'llm' \| 'rules'` |
| `packages/web/src/features/inbox/AiSuggestion.tsx` | 详情页标注「MiMo 识别」/「规则兜底」 |

## 4. 数据流

```
平台 Webhook / IMAP 轮询
        │
        ▼
 ingest()  保存 → 写 received 日志 → 立即广播 message.received  ← 不等待 AI
        │
        └─(后台)─▶ enrich()
                     ├─ OCR（占位）
                     └─ LlmService.analyze()  ── 真实调用 ──▶ MiMo
                              │  成功                │ 失败/超时/低置信
                              ▼                      ▼
                        intentSource='llm'      intentSource='rules'
                              └──────┬───────────────┘
                                     ▼
                     写 trace + 广播 message.updated（前端就地刷新）
```

为什么异步：真实调用实测平均 5.47s、最大 9.3s。同步等待会让 Webhook 响应被拖住（平台超时会重推）并让收件箱迟迟不出新消息。

## 5. 实测数据（2026-11-11）

意图识别抽样，5 条业务样例（MiMo flash vs 关键词规则）：

| 消息 | flash | 关键词规则 | 延迟 | tokens |
|---|---|---|---|---|
| 麻烦把 Q3 复盘的材料在周五下班前发我一份 | 待办 ✅ | 未分类 ❌ | 2.90s | 173 |
| 这个接口的鉴权头应该放哪个字段？ | 咨询 ✅ | 咨询 ✅ | 4.86s | 164 |
| 系统将于本周六凌晨升级，期间服务不可用 | 通知 ✅ | 未分类 ❌ | 2.93s | 150 |
| 明天上午十点会议室A301对齐一下排期 | 待办 ✅ | 通知 ❌ | 7.37s | 272 |
| 收到，谢谢 | 未分类 ✅ | 未分类 ✅ | 9.30s | 337 |

- 命中率：**flash 5/5**，关键词规则 2/5；平均 5.47s，P100 9.30s。
- `pnpm run doctor` 真实探针：`mimo-v2.6-flash 响应 2473ms，识别为「待办」（0.95，179 tokens）`。
- 端到端（浏览器实拍）：Webhook 回执 **25ms**、消息 **27ms** 可见、意图 **2734ms** 填充，界面不刷新即更新，详情页显示「MiMo 识别」。

## 6. 配置与替换

```bash
# .env（不会进仓库）
LLM_PROVIDER=openai
LLM_API_KEY=sk-...
LLM_MODEL=mimo-v2.6-flash
LLM_ENDPOINT=https://api.xiaomimimo.com/v1
LLM_TIMEOUT_MS=15000
LLM_MIN_CONFIDENCE=0.6
```

换其他 OpenAI 兼容服务商只改两行：

| 服务商 | `LLM_ENDPOINT` | 模型示例 |
|---|---|---|
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |

不填 Key / `LLM_PROVIDER=mock` → 走内置规则识别，零密钥也能完整演示；`pnpm run doctor` 会明确给出 SKIP 与启用步骤。

## 7. 安全与成本

- Key 只在服务端读取，不写日志、不进前端 bundle、不进 doctor 报告（探针只报模型名与延迟）。
- `.env` 已被 `.gitignore` 忽略；交付包由 `git archive` 生成，天然不含凭据。
- 成本：flash 单条约 150–340 tokens，按每条入站消息一次调用估算，日常演示量级成本可忽略。
- 限流：429/503 重试一次后回退规则，不阻塞消息入库。
