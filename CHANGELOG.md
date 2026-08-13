# 更新日志

本项目版本号以 `workers/wrangler.toml` 中的 `APP_VERSION` 为唯一源头，前端在运行时从 `/api/about` 读取。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [4.0.0] - 2026-08

### 重大更新 — 核心质量全面升级

> 从 3.x 到 4.0 是一次基础设施级别的质量重构，覆盖类型安全、错误处理、测试覆盖、安全加固、自动运维和 MCP 工具生态。

### 类型安全全面强化（P0）

- 消除代码库中所有 `any` 类型，替换为精确的 TypeScript 接口和类型定义
- 消除所有 `catch (e: any)` 模式，统一使用 `unknown` 类型配合类型守卫
- 新增 `ProviderError`、`ValidationError`、`AuthError`、`NotFoundError`、`RateLimitError`、`UpstreamError` 等结构化错误类型
- 所有工具函数和中间件增加完整的类型签名

### 统一错误处理（P0）

- 创建集中式错误处理模块 `workers/src/lib/errors.ts`
- 标准化错误响应格式：`{ error: { code, message, status } }`
- 全局错误中间件统一捕获所有未处理异常，确保响应格式一致
- 消除各路由中零散的 try/catch 和重复的错误处理逻辑

### 测试框架搭建（P0）

- 引入 vitest 测试框架，配置完整的测试环境
- 编写 38 个测试用例，覆盖：
  - 加密模块（AES-256-GCM 加解密、PBKDF2 哈希、Base64 编解码）
  - 错误处理模块（所有错误类型的实例化、序列化、isXxx 类型守卫）
  - 响应工具模块（成功/错误响应构造、JSON 序列化）
- 所有测试通过，持续集成就绪

### 安全加固

- PBKDF2 密码哈希迭代次数从 100,000 提升至 **600,000**（6 倍），显著提升暴力破解成本
- `ENCRYPTION_KEY` 不在 `wrangler.toml` 中硬编码，改为通过 Secrets 注入

### 代码质量与架构

- 提取公共 fallback 执行逻辑为独立模块 `fallback-executor.ts`，消除 `mcp.ts` 和 `router.ts` 中的代码重复
- 统一工具函数的命名和参数约定，提升代码可维护性
- 完善 TypeScript 配置，启用严格模式检查

### 自动运维

- 新增 `request_logs` 自动清理 Cron Job（`0 4 * * *` 每日凌晨清理 30 天前的日志）
- 验证 D1 外键约束完整性，确保数据一致性

### MCP 工具生态

- **mcp-llm-chat**：LLM 对话交互工具，支持多轮对话和模型查询
- **mcp-admin**：管理面板操作工具，支持密钥、令牌、模型、提供商管理
- **mcp-provider-monitor**：提供商监控工具，支持健康检查、请求统计、延迟分析
- 三个 MCP 工具均独立部署为 Cloudflare Workers，使用 TypeScript 重写，类型安全 + 完整错误处理

### Dashboard 前端同步

- `freellmapi-cf-dashboard` 版本号同步更新至 4.0.0，与后端保持一致
- 前端版本号运行时从后端 `/api/about` 读取，确保显示与实际部署一致

### 依赖升级

- 升级所有 npm 依赖至最新兼容版本
- 所有 MCP 工具依赖统一管理

---

## [2.5.0] - 2026-07

### 亮色模式全面修复

- 修复亮色模式下管理面板所有页面的配色问题，确保文字、背景、边框对比度达标
- 修复亮色模式下卡片、表格、输入框、按钮等组件的样式不可读问题
- 修复主题切换时部分元素未跟随主题更新的残留样式
- 优化暗色/亮色/跟随系统三种模式之间的平滑切换体验
- 统一 CSS 变量命名体系，消除硬编码颜色值

### i18n 英文翻译补全

- 补全所有界面的英文翻译，覆盖模型页、试玩台、密钥页、分析页、设置页、关于页、登录页
- 修复部分字符串在英文模式下回退到中文的问题
- 补全错误提示、警告信息、空状态文案的英文翻译
- 优化语言切换的实时响应，切换后所有组件立即重渲染

### 其他改进

- 优化前端版本号读取逻辑，确保从后端 `/api/about` 运行时获取
- 改进 CORS 处理，修复跨域请求在特定浏览器下被吞的问题

---

## [2.4.2] - 2026-06

### 修复

- 修复分析页数据量过大时页面卡顿问题，增加折叠/展开功能
- 分析页最近请求列表默认显示部分条目，支持「展开剩余 N 条」
- 修复分析页图表在数据为空时的渲染异常

---

## [2.4.1] - 2026-06

### 修复

- 修复 GitHub Models 提供商健康检查失败的问题（端点变更导致）
- 修复版本号在前后端不一致的问题
- 修复设置页批量操作后列表未及时刷新的问题

---

## [2.4.0] - 2026-06

### 新增

- **自定义提供商密钥**：支持添加任意 OpenAI 兼容端点（如 DeepSeek、月之暗面等），可自定义 Base URL、模型列表、密钥和标签
- **动态提供商管理**：设置页支持动态添加和删除提供商，无需修改代码重新部署
- 设置页新增批量设置免费额度功能（RPM、RPD、TPM、TPD），可一键应用到某平台所有模型
- 设置页新增模型批量删除功能
- 密钥页新增「同步模型」功能，可从上游拉取最新模型列表

### 修复

- 修复 GitHub Models 健康检查的端点适配问题
- **版本号统一**：将版本号统一到 `wrangler.toml` 的 `APP_VERSION` 作为唯一源头，前端运行时从后端读取，消除多处硬编码版本号不一致的问题
- 修复分析页在请求数量过大时的性能问题，增加折叠/展开功能

### 变更

- 设置页 UI 重构，按平台分组展示，支持折叠/展开
- 密钥列表支持折叠/展开，优化大量密钥时的浏览体验

---

## [2.3.0] - 2026-05

### 新增

- **前端版本号运行时读取**：前端不再硬编码版本号，改为运行时从后端 `/api/about` 接口读取，确保版本号唯一源头为 `wrangler.toml` 的 `APP_VERSION`
- 页脚动态显示当前版本号

### 修复

- 修复前端显示的版本号与后端实际部署版本不一致的问题
- 修复关于页版本号加载失败的容错处理

---

## [2.2.0] - 2026-04

### 新增

- 新增 `/v1/responses` 端点（Responses API）
- 新增 `/v1/images/generations` 端点（图像生成）
- 新增 `/v1/audio/speech` 端点（语音合成 TTS）
- 试玩台新增路由模式选择：自动回退、融合、最快、最智能、手动
- 试玩台支持显示模型元信息（平台、上下文窗口、工具/视觉支持、激活 key 数）

### 改进

- 优化 SSE 流式响应标准化逻辑，统一不同提供商的流式输出格式
- 改进 fallback 链的错误处理，提供更清晰的错误信息

---

## [2.1.0] - 2026-03

### 新增

- **分析页**：请求统计仪表盘，包含请求数、成功率、Token 用量、平均延迟、预估节省
- 按提供商的请求数和延迟分布图表
- 按模型细分的请求统计
- 7 天请求趋势图
- 最近请求记录表（含时间、模型、平台、状态码、延迟、Token 数）

### 改进

- 优化 D1 查询性能，为 `request_logs` 表增加索引
- 改进密钥健康检查逻辑，支持更多提供商的状态检测

---

## [2.0.0] - 2026-02

### 重大更新

将 [freellmapi](https://github.com/tashfeenahmed/freellmapi) 完整重写到 Cloudflare Workers 平台。

### 新增

- **核心路由引擎**：支持自动 fallback 链，请求失败时自动切换到下一个可用提供商/密钥
- **OpenAI 兼容 API**：
  - `POST /v1/chat/completions`（对话补全，支持流式）
  - `GET /v1/models`（模型列表）
  - `POST /v1/completions`（文本补全）
  - `POST /v1/embeddings`（向量嵌入）
- **Anthropic Messages API 兼容**：`POST /v1/messages`（Claude Code 可直接使用）
- **密钥管理**：
  - AES-256-GCM 加密存储所有上游 API Key
  - 添加密钥后仅显示一次明文，列表中脱敏显示
  - 支持临时显示完整密钥（10 秒自动隐藏）
  - 密钥健康检查
  - 启用/禁用/删除密钥
- **统一 API Token**：客户端使用单个 `freellmapi-xxx` 格式的 token 访问所有模型
- **Per-key 速率跟踪**：基于 Durable Objects 的强一致计数（RPM/TPM，分钟/天级）
- **Sticky Session**：30 分钟粘性会话
- **管理面板**（React + Vite + TailwindCSS）：
  - 模型管理页
  - 试玩台
  - 密钥管理页
  - 设置页
  - 关于页
  - 登录/首次设置页
- **基础设施**：
  - Cloudflare D1 数据库（SQLite 兼容）
  - Cloudflare KV 命名空间（配置缓存）
  - Durable Objects（KeyState + Session）
  - Cron Triggers（每 12 小时同步模型目录）
- **GitHub Actions 自动部署**：push 到 main 分支自动部署后端和前端
- **安全**：
  - scrypt 密码哈希
  - JWT 会话管理
  - 管理员启动码（ADMIN_BOOTSTRAP_CODE）防止他人注册
  - CORS 跨域支持

### 支持的提供商（初始 18 个）

Groq、Google Gemini、Cerebras、OpenCode Zen、Mistral、OpenRouter、GitHub Models、Cloudflare Workers AI、Cohere、Z.ai、NVIDIA NIM、HuggingFace、Ollama Cloud、Kilo、Pollinations、LLM7、OVH AI Endpoints、AI Horde

---

## [1.0.0] - 2026-01

### 初始版本

- 项目立项，基于 [freellmapi](https://github.com/tashfeenahmed/freellmapi) 原版项目
- 确定技术方案：Cloudflare Workers + Hono + D1 + KV + Durable Objects
- 基础项目结构搭建
- 基础路由和提供商适配器框架

---

## 版本号说明

| 版本段 | 含义 |
|--------|------|
| 主版本号 (X) | 不兼容的 API 变更 |
| 次版本号 (Y) | 向下兼容的新功能 |
| 修订号 (Z) | 向下兼容的 Bug 修复 |

> 当前版本：**4.0.0**（见 `workers/wrangler.toml` 中的 `APP_VERSION`）
