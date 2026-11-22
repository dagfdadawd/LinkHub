-- 赛题A · 增量迁移 002：优先级 / 自动回复规则
-- 与 001 一样：默认内存仓储下不执行；接入 Postgres 时按序执行即可。
-- 内存实现与这里的列/表保持同构，避免「文档有、代码没有」的两套口径。

-- 优先级：AI/规则给默认值，人工可改；source 如实记录判定来自哪条通道。
ALTER TABLE unified_messages
  ADD COLUMN IF NOT EXISTS priority        VARCHAR(8),   -- urgent / normal / low
  ADD COLUMN IF NOT EXISTS priority_source VARCHAR(8);   -- llm / rules / manual

CREATE INDEX IF NOT EXISTS idx_messages_priority
  ON unified_messages(priority, created_at DESC);

-- 自动回复规则（内存实现落盘为 DATA_DIR/auto-rules.json，表结构与之对齐）
CREATE TABLE IF NOT EXISTS auto_rules (
  id          TEXT PRIMARY KEY,
  platform    TEXT,                       -- NULL = 所有平台
  keyword     TEXT,                       -- NULL/空 = 该平台兜底规则
  reply_text  TEXT NOT NULL,
  priority    INTEGER NOT NULL DEFAULT 100,  -- 数字越小越先匹配
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  hit_count   INTEGER NOT NULL DEFAULT 0,
  last_hit_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auto_rules_match
  ON auto_rules(enabled, priority, created_at);
