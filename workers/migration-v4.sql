-- ============================================================
-- v4.0 迁移脚本 — 为已有 D1 数据库添加 RSS 同步相关列
-- 用法: wrangler d1 execute freellmapi --file=./migration-v4.sql
-- ============================================================

-- models 表:添加 categories 列(存储 RSS 分类标签,逗号分隔,如 '对话,视觉理解')
-- 如果列已存在会报错,忽略即可
ALTER TABLE models ADD COLUMN categories TEXT;

-- 默认 catalog_url 切换为 RSS 源(已有数据库里旧值不会被覆盖,如需切换手动执行:
--   UPDATE settings SET value = 'https://rss.zjkl.dpdns.org/rss.xml' WHERE key = 'catalog_url';
-- )
INSERT OR IGNORE INTO settings (key, value) VALUES ('catalog_url', 'https://rss.zjkl.dpdns.org/rss.xml');
