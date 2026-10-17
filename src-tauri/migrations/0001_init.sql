-- ============================================================
-- 旧版（改名前叫 OnTheWay）的初始表结构
-- 对应技术方案 §5.3。迁移一旦发布就不再修改，只能追加新文件。
--
-- 约定：
--   主键      TEXT，UUIDv7（时间有序，索引局部性好，为将来同步预留）
--   时间戳    INTEGER，UTC 毫秒
--   本地日期  TEXT，'YYYY-MM-DD'（全天事件必须用它，否则跨时区会差一天）
--   软删除    deleted_at INTEGER NULL，永不物理删除
-- ============================================================

-- ============================== 笔记 ==============================
CREATE TABLE note (
  id             TEXT    PRIMARY KEY,
  title          TEXT    NOT NULL DEFAULT '',
  content_md     TEXT    NOT NULL DEFAULT '',
  -- jieba 分词后的空格分隔串，只供 FTS 用，不展示
  content_tokens TEXT    NOT NULL DEFAULT '',
  -- 列表渲染用的摘要，避免为了显示一行字去读全文
  excerpt        TEXT    NOT NULL DEFAULT '',
  icon           TEXT    NOT NULL DEFAULT 'file',
  word_count     INTEGER NOT NULL DEFAULT 0,
  is_pinned      INTEGER NOT NULL DEFAULT 0,
  is_archived    INTEGER NOT NULL DEFAULT 0,
  archive_category TEXT,
  archived_at    INTEGER,
  -- 行动项分组的标题，如「下阶段行动」。NULL 表示这篇笔记没有行动项。
  action_title   TEXT,
  sort_key       TEXT    NOT NULL DEFAULT 'a0',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER
);
CREATE INDEX idx_note_updated  ON note(is_archived, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_note_pinned   ON note(is_pinned DESC, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_note_archived ON note(archived_at DESC) WHERE is_archived = 1 AND deleted_at IS NULL;

-- 外部内容 FTS5：不复制正文，只建索引
-- 分词器用 unicode61，中文靠写入前的 jieba 预切分（见 domain/search.rs）
CREATE VIRTUAL TABLE note_fts USING fts5(
  title,
  content_tokens,
  content       = 'note',
  content_rowid = 'rowid',
  tokenize      = "unicode61 remove_diacritics 2"
);

CREATE TRIGGER note_ai AFTER INSERT ON note BEGIN
  INSERT INTO note_fts(rowid, title, content_tokens)
  VALUES (new.rowid, new.title, new.content_tokens);
END;
CREATE TRIGGER note_ad AFTER DELETE ON note BEGIN
  INSERT INTO note_fts(note_fts, rowid, title, content_tokens)
  VALUES ('delete', old.rowid, old.title, old.content_tokens);
END;
CREATE TRIGGER note_au AFTER UPDATE ON note BEGIN
  INSERT INTO note_fts(note_fts, rowid, title, content_tokens)
  VALUES ('delete', old.rowid, old.title, old.content_tokens);
  INSERT INTO note_fts(rowid, title, content_tokens)
  VALUES (new.rowid, new.title, new.content_tokens);
END;

-- ============================== 目标 ==============================
CREATE TABLE goal (
  id              TEXT    PRIMARY KEY,
  title           TEXT    NOT NULL,
  description_md  TEXT    NOT NULL DEFAULT '',
  -- 行动项分组之后的正文（GOAL 页的「记录」段）
  after_md        TEXT    NOT NULL DEFAULT '',
  status          TEXT    NOT NULL DEFAULT 'active',   -- draft|active|paused|achieved|dropped
  horizon         TEXT    NOT NULL DEFAULT 'week',     -- week|month|year
  period_start    TEXT    NOT NULL,                    -- 'YYYY-MM-DD'
  action_title    TEXT,                                -- 行动项分组的标题，如「本周重点」
  category        TEXT,
  color           TEXT,
  parent_id       TEXT    REFERENCES goal(id) ON DELETE SET NULL,
  progress_mode   TEXT    NOT NULL DEFAULT 'task',     -- task|kr|manual
  progress_manual REAL,
  target_date     TEXT,
  achieved_at     INTEGER,
  sort_key        TEXT    NOT NULL DEFAULT 'a0',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  CHECK (horizon IN ('week','month','year'))
);
CREATE INDEX idx_goal_horizon ON goal(horizon, period_start DESC) WHERE deleted_at IS NULL;

CREATE TABLE key_result (
  id            TEXT    PRIMARY KEY,
  goal_id       TEXT    NOT NULL REFERENCES goal(id) ON DELETE CASCADE,
  title         TEXT    NOT NULL,
  unit          TEXT    NOT NULL DEFAULT '',
  start_value   REAL    NOT NULL DEFAULT 0,
  target_value  REAL    NOT NULL,
  current_value REAL    NOT NULL DEFAULT 0,
  sort_key      TEXT    NOT NULL DEFAULT 'a0',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_kr_goal ON key_result(goal_id, sort_key);

-- ============================== 待办 ==============================
CREATE TABLE task (
  id           TEXT    PRIMARY KEY,
  title        TEXT    NOT NULL,
  notes_md     TEXT    NOT NULL DEFAULT '',
  status       TEXT    NOT NULL DEFAULT 'todo',   -- todo|doing|done|cancelled
  -- 行动项下方的灰色小字：「负责人 · 以安」「周一 10:00」「截止 9月4日」
  meta         TEXT,
  priority     INTEGER NOT NULL DEFAULT 0,
  is_all_day   INTEGER NOT NULL DEFAULT 1,
  due_date     TEXT,                              -- 'YYYY-MM-DD'
  due_at       INTEGER,                           -- UTC ms
  time_label   TEXT,                              -- 展示用「上午」「16:00」
  category     TEXT,                              -- 「产品」「/GOAL」「健康」
  remind_at    INTEGER,
  rrule        TEXT,
  completed_at INTEGER,
  goal_id      TEXT    REFERENCES goal(id) ON DELETE SET NULL,
  parent_id    TEXT    REFERENCES task(id) ON DELETE CASCADE,
  sort_key     TEXT    NOT NULL DEFAULT 'a0',     -- fractional index
  estimate_min INTEGER,
  actual_min   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  CHECK (status IN ('todo','doing','done','cancelled'))
);
CREATE INDEX idx_task_due  ON task(due_date) WHERE deleted_at IS NULL AND status != 'done';
CREATE INDEX idx_task_goal ON task(goal_id, sort_key) WHERE deleted_at IS NULL;
CREATE INDEX idx_task_done ON task(completed_at DESC) WHERE completed_at IS NOT NULL;

-- ============================== 日历 ==============================
CREATE TABLE calendar (
  id         TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  color      TEXT    NOT NULL,
  is_visible INTEGER NOT NULL DEFAULT 1,
  sort_key   TEXT    NOT NULL DEFAULT 'a0',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE event (
  id             TEXT    PRIMARY KEY,
  calendar_id    TEXT    NOT NULL REFERENCES calendar(id) ON DELETE CASCADE,
  title          TEXT    NOT NULL,
  description_md TEXT    NOT NULL DEFAULT '',
  location       TEXT,
  is_all_day     INTEGER NOT NULL DEFAULT 0,
  start_at       INTEGER,      -- 定时：UTC ms
  end_at         INTEGER,
  start_date     TEXT,         -- 全天：'YYYY-MM-DD'（含）
  end_date       TEXT,
  -- IANA 时区。重复规则必须在事件原始时区里展开，跨夏令时才正确
  tz             TEXT    NOT NULL DEFAULT 'Asia/Shanghai',
  rrule          TEXT,         -- RFC 5545 RRULE 部分，不含 DTSTART
  exdates        TEXT,         -- JSON 数组：被排除的 occurrence 起始 UTC ms
  task_id        TEXT    REFERENCES task(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER,
  CHECK ((is_all_day = 1 AND start_date IS NOT NULL)
      OR (is_all_day = 0 AND start_at   IS NOT NULL))
);
CREATE INDEX idx_event_range  ON event(start_at, end_at)     WHERE deleted_at IS NULL;
CREATE INDEX idx_event_allday ON event(start_date, end_date) WHERE deleted_at IS NULL;

CREATE TABLE event_override (
  id             TEXT    PRIMARY KEY,
  event_id       TEXT    NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  occurrence_at  INTEGER NOT NULL,     -- 原始 occurrence 起始 UTC ms（RECURRENCE-ID）
  is_cancelled   INTEGER NOT NULL DEFAULT 0,
  title          TEXT,                 -- NULL = 沿用母事件
  start_at       INTEGER,
  end_at         INTEGER,
  description_md TEXT,
  location       TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (event_id, occurrence_at)
);

-- 日历某一天的备注（原型里点日期后右侧的「备注」段）
CREATE TABLE day_doc (
  date       TEXT    PRIMARY KEY,     -- 'YYYY-MM-DD'
  note_md    TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ============================== 标签与链接 ==============================
CREATE TABLE tag (
  id         TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL UNIQUE,
  color      TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE entity_tag (
  entity_type TEXT NOT NULL,      -- note|task|goal|event|review
  entity_id   TEXT NOT NULL,
  tag_id      TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  PRIMARY KEY (entity_type, entity_id, tag_id)
);
CREATE INDEX idx_entity_tag_rev ON entity_tag(tag_id, entity_type);

-- 跨模块整合的核心：多态双向链接。
-- 「笔记的下阶段行动」「目标的本周重点」都通过它把 task 挂到宿主文档上。
CREATE TABLE link (
  id         TEXT    PRIMARY KEY,
  src_type   TEXT    NOT NULL,
  src_id     TEXT    NOT NULL,
  dst_type   TEXT    NOT NULL,
  dst_id     TEXT    NOT NULL,
  kind       TEXT    NOT NULL DEFAULT 'ref',   -- ref|action|derived_from|blocks
  sort_key   TEXT    NOT NULL DEFAULT 'a0',
  created_at INTEGER NOT NULL,
  UNIQUE (src_type, src_id, dst_type, dst_id, kind)
);
CREATE INDEX idx_link_src ON link(src_type, src_id, kind, sort_key);
CREATE INDEX idx_link_dst ON link(dst_type, dst_id);

-- ============================== 复盘 ==============================
CREATE TABLE review (
  id            TEXT    PRIMARY KEY,
  period        TEXT    NOT NULL,      -- day|week|month|quarter|year
  period_start  TEXT    NOT NULL,      -- 'YYYY-MM-DD' 本地日期
  content_md    TEXT    NOT NULL DEFAULT '',
  mood          INTEGER,
  energy        INTEGER,
  focus_min     INTEGER,
  -- 生成复盘时冻结的统计快照：三个月后回看，看到的还是当时的数字
  snapshot_json TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER,
  UNIQUE (period, period_start)
);

-- append-only 行为日志：复盘统计的唯一可信来源。
-- 不能从 task 现状统计 —— 任务被重开、改期后历史就没了。
CREATE TABLE activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,        -- UTC ms
  local_date  TEXT    NOT NULL,        -- 'YYYY-MM-DD'，按天聚合直接用
  entity_type TEXT    NOT NULL,
  entity_id   TEXT    NOT NULL,
  action      TEXT    NOT NULL,        -- created|updated|completed|reopened|archived|...
  payload     TEXT
);
CREATE INDEX idx_activity_date   ON activity(local_date);
CREATE INDEX idx_activity_entity ON activity(entity_type, entity_id, at DESC);

-- ============================== 设置 ==============================
CREATE TABLE setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL        -- JSON
);
