-- ============================================================
-- v3.0 迁移脚本 — 为已有 D1 数据库添加缺失的列
-- 用法: wrangler d1 execute freellmapi --file=./migration-v3.sql
-- ============================================================

-- api_keys 表:添加 custom_base_url 列(custom 平台需要)
-- 如果列已存在会报错,忽略即可
ALTER TABLE api_keys ADD COLUMN custom_base_url TEXT;

-- models 表:添加 created_at 列(autoDiscoverModels 需要)
ALTER TABLE models ADD COLUMN created_at INTEGER NOT NULL DEFAULT (unixepoch());
