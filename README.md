# freellmapi-cf

> 统一大模型 API 路由器，部署在 Cloudflare Workers 上，支持 19+ 个 LLM 提供商。

[![Deploy to Cloudflare](https://github.com/<your-username>/freellmapi-cf/actions/workflows/deploy.yml/badge.svg)](https://github.com/<your-username>/freellmapi-cf/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-2.5.0-brightgreen.svg)](CHANGELOG.md)

freellmapi-cf 是一个开源的统一 LLM API 路由器。它将多个大模型提供商的 API 聚合到一个统一的 OpenAI 兼容端点，让你用一个 API Key 就能访问所有支持的模型。整个项目运行在 Cloudflare Workers 边缘网络之上，享受全球低延迟和免费额度。

---

## 目录

- [功能特性](#功能特性)
- [架构概览](#架构概览)
- [支持的提供商](#支持的提供商)
- [前置要求](#前置要求)
- [部署步骤](#部署步骤)
- [数据库表结构](#数据库表结构)
- [API 端点](#api-端点)
- [使用示例](#使用示例)
- [自定义提供商配置](#自定义提供商配置)
- [技术栈](#技术栈)
- [本地开发](#本地开发)
- [贡献指南](#贡献指南)
- [许可证](#许可证)

---

## 功能特性

### 核心路由

- **19+ 个 LLM 提供商**统一接入，包括 Groq、Google Gemini、Cerebras、Mistral、OpenRouter、GitHub Models、Cloudflare Workers AI、Cohere、Z.ai、NVIDIA NIM、HuggingFace、Ollama Cloud、Kilo、Pollinations、LLM7、OVH AI Endpoints、AI Horde、OpenCode Zen 等
- **OpenAI 兼容 API**：`/v1/chat/completions`、`/v1/models`、`/v1/embeddings`、`/v1/completions`、`/v1/images/generations`、`/v1/audio/speech`、`/v1/responses`
- **Anthropic Messages API 兼容**：`/v1/messages`（Claude Code 可直接使用）
- **自动 fallback 链**：请求失败时自动切换到下一个可用提供商/密钥
- **多种路由策略**：自动回退、融合（并行多模型）、最快、最智能、手动

### 安全与密钥管理

- **AES-256-GCM 加密存储**所有上游 API Key，数据库中只存密文
- **统一 API Token**：客户端只需一个 `freellmapi-xxx` 格式的 token 即可访问所有模型
- **Per-key 速率跟踪**：基于 Durable Objects 的强一致计数，精确到分钟/天级 RPM 与 TPM
- **Sticky Session**：30 分钟粘性会话，同一会话尽量复用同一上游
- **密钥健康检查**：实时检测密钥状态（healthy / rate_limited / invalid / error）
- **密钥安全展示**：添加后仅显示一次明文，列表中脱敏显示，支持临时显示 10 秒

### 管理面板

- **模型管理页**：查看/启用/禁用模型，调整路由策略
- **试玩台**：内置聊天界面，直接测试路由结果
- **密钥管理页**：添加、删除、健康检查、临时显示上游密钥
- **分析页**：请求统计、成功率、Token 用量、延迟分布、按提供商/模型细分
- **设置页**：动态添加/删除提供商，批量设置免费额度，管理模型
- **关于页**：服务实时运行状态、数据中心、累计统计
- **亮色/暗色主题**切换，跟随系统
- **中英双语 i18n** 完整支持

### 基础设施

- **Cron Triggers**：每 12 小时自动同步远程模型目录
- **GitHub Actions 自动部署**：push 到 main 分支即自动部署后端和前端
- **自定义域名**支持
- **D1 数据备份**支持

---

## 架构概览

```
                            ┌─────────────────────────────────┐
                            │        客户端 / SDK             │
                            │  (OpenAI SDK / Anthropic SDK    │
                            │   / curl / 任意 HTTP 客户端)     │
                            └──────────────┬──────────────────┘
                                           │
                          Authorization: Bearer freellmapi-xxx
                                           │
                                           ▼
              ┌────────────────────────────────────────────────────┐
              │            Cloudflare Workers (Hono)                │
              │                                                      │
              │  ┌─────────────┐   ┌──────────────┐                 │
              │  │  /v1/* 路由  │   │  /api/* 路由  │                │
              │  │ (OpenAI 兼容) │   │ (Dashboard)  │                │
              │  └──────┬──────┘   └──────┬───────┘                 │
              │         │                 │                          │
              │  ┌──────▼─────────────────▼───────┐                 │
              │  │        路由引擎 (router)         │                │
              │  │  pickRoute → fallback chain     │                │
              │  └──────┬──────────────────────────┘                │
              │         │                                            │
              │  ┌──────▼──────┐  ┌───────────┐  ┌──────────────┐   │
              │  │  D1 (SQLite) │  │    KV     │  │ Durable Obj  │   │
              │  │ 账号/密钥/   │  │ 配置缓存  │  │ 速率/会话    │   │
              │  │ 模型/日志    │  │           │  │              │   │
              │  └─────────────┘  └───────────┘  └──────────────┘   │
              │                                                      │
              │  ┌─────────────────────────────────────────────┐    │
              │  │           Providers (19+)                    │    │
              │  │  Groq | Google | Cerebras | Mistral |        │    │
              │  │  OpenRouter | GitHub | Cloudflare | Cohere |  │    │
              │  │  Z.ai | NVIDIA | HuggingFace | Ollama |      │    │
              │  │  Kilo | Pollinations | LLM7 | OVH |          │    │
              │  │  AI Horde | OpenCode | Custom ...            │    │
              │  └──────────────────────┬──────────────────────┘    │
              └─────────────────────────┼───────────────────────────┘
                                        │
                         ┌──────────────▼──────────────┐
                         │   上游 LLM 提供商 API        │
                         │  (各平台 OpenAI 兼容端点)    │
                         └─────────────────────────────┘

  ┌─────────────┐         ┌──────────────────────────────────────┐
  │ Cron Trigger │         │     Cloudflare Pages (前端)           │
  │ 每 12 小时   │         │   React 18 + Vite + TailwindCSS      │
  │ 同步模型目录 │         │   Models | Playground | Keys |        │
  └─────────────┘         │   Analytics | Settings | About        │
                          └──────────────────────────────────────┘
```

### 目录结构

```
freellmapi-cf/
├── workers/                       # Cloudflare Workers 后端
│   ├── src/
│   │   ├── index.ts               # 主入口（路由注册、Cron、CORS）
│   │   ├── types.ts               # 类型定义（Env、Platform、Model 等）
│   │   ├── routes/
│   │   │   ├── api/               # Dashboard API
│   │   │   │   ├── auth.ts        # 登录/注册/会话
│   │   │   │   ├── keys.ts        # 上游密钥管理
│   │   │   │   ├── tokens.ts      # 统一 Token 管理
│   │   │   │   ├── analytics.ts   # 请求分析
│   │   │   │   ├── models.ts      # 模型/fallback 管理
│   │   │   │   ├── settings.ts    # 系统设置
│   │   │   │   └── about.ts       # 服务信息
│   │   │   └── v1/                # OpenAI / Anthropic 兼容 API
│   │   │       ├── chat.ts        # /v1/chat/completions
│   │   │       ├── completions.ts # /v1/completions
│   │   │       ├── models.ts      # /v1/models
│   │   │       ├── embeddings.ts  # /v1/embeddings
│   │   │       ├── images.ts      # /v1/images/generations
│   │   │       ├── audio.ts       # /v1/audio/speech
│   │   │       └── messages.ts    # /v1/messages (Anthropic)
│   │   ├── providers/             # 19+ 提供商适配器
│   │   │   ├── base.ts            # 基类
│   │   │   ├── index.ts           # 注册表
│   │   │   ├── groq.ts
│   │   │   ├── google.ts
│   │   │   ├── ...（每个提供商一个文件）
│   │   │   └── custom.ts          # 自定义 OpenAI 兼容端点
│   │   ├── lib/
│   │   │   ├── auth.ts            # 鉴权中间件
│   │   │   ├── crypto.ts          # AES-256-GCM 加解密
│   │   │   ├── router.ts          # 路由选择 + fallback
│   │   │   ├── stream.ts          # SSE 流式响应标准化
│   │   │   └── response.ts        # 响应工具函数
│   │   └── durable-objects/
│   │       ├── KeyState.ts        # Per-key 速率计数
│   │       └── Session.ts         # 粘性会话
│   ├── schema.sql                 # D1 数据库建表
│   ├── seed-models.sql            # 初始模型种子数据
│   └── wrangler.toml              # Workers 配置
├── pages/                         # Cloudflare Pages 前端
│   ├── src/
│   │   ├── App.tsx                # 主应用 + 路由
│   │   ├── Root.tsx
│   │   ├── main.tsx
│   │   ├── index.css
│   │   ├── components/
│   │   │   └── TopMenu.tsx        # 顶部菜单（主题/语言切换）
│   │   ├── lib/
│   │   │   ├── api.ts             # API 调用封装
│   │   │   ├── auth.tsx           # 前端鉴权
│   │   │   └── i18n.ts            # 中英双语
│   │   └── pages/
│   │       ├── Models.tsx
│   │       ├── Playground.tsx
│   │       ├── Keys.tsx
│   │       ├── Analytics.tsx
│   │       ├── Settings.tsx
│   │       ├── About.tsx
│   │       └── Login.tsx
│   ├── functions/                 # Pages Functions 代理
│   ├── index.html
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   └── package.json
├── .github/
│   └── workflows/
│       └── deploy.yml             # GitHub Actions 自动部署
├── README.md
├── CHANGELOG.md
├── LICENSE
├── CONTRIBUTING.md
├── DISCLAIMER.md
└── .gitignore
```

---

## 支持的提供商

| 平台 ID | 显示名称 | 说明 |
|---------|---------|------|
| `groq` | Groq | 超低延迟推理 |
| `google` | Google Gemini | Gemini 系列模型 |
| `cerebras` | Cerebras | 高速推理 |
| `opencode` | OpenCode Zen | 免费推理 |
| `mistral` | Mistral | Mistral 系列模型 |
| `openrouter` | OpenRouter | 多模型聚合 |
| `github` | GitHub Models | GitHub 提供的免费模型 |
| `cloudflare` | Cloudflare Workers AI | CF 内置 AI |
| `cohere` | Cohere | Command R 系列 |
| `zai` | Z.ai (智谱) | GLM 系列模型 |
| `nvidia` | NVIDIA NIM | NVIDIA 推理微服务 |
| `huggingface` | HuggingFace | HF Inference API |
| `ollama` | Ollama Cloud | Ollama 云端 |
| `kilo` | Kilo Gateway | Kilo 网关 |
| `pollinations` | Pollinations | 免费文本/图像生成 |
| `llm7` | LLM7 | 免费推理 |
| `ovh` | OVH AI Endpoints | OVH 托管 AI |
| `aihorde` | AI Horde | 众包推理 |
| `custom` | Custom | 任意 OpenAI 兼容端点 |

---

## 前置要求

在开始部署之前，请确保你已具备以下条件：

| 要求 | 说明 |
|------|------|
| **Cloudflare 账号** | [注册](https://dash.cloudflare.com/sign-up)免费账号即可，无需绑定信用卡 |
| **Node.js 20+** | 用于本地运行 `wrangler` CLI 和构建前端 |
| **wrangler CLI** | Cloudflare 官方命令行工具，通过 npm 安装 |
| **Git** | 用于克隆仓库和版本管理 |
| **openssl** | 用于生成加密密钥（macOS/Linux 自带，Windows 可用 Git Bash） |

### 安装 wrangler

```bash
npm install -g wrangler
# 或者使用 npx（推荐，无需全局安装）
npx wrangler --version
```

---

## 部署步骤

### a. 克隆仓库

```bash
git clone https://github.com/<your-username>/freellmapi-cf.git
cd freellmapi-cf
```

### b. 安装依赖

```bash
# 后端依赖
cd workers
npm install

# 前端依赖
cd ../pages
npm install
```

### c. 创建 D1 数据库

```bash
cd workers

# 登录 Cloudflare（首次会打开浏览器授权）
npx wrangler login

# 创建 D1 数据库
npx wrangler d1 create freellmapi
```

命令执行后会输出类似如下内容，**记下 `database_id`**：

```
✅ Successfully created DB 'freellmapi'
[[d1_databases]]
binding = "DB"
database_name = "freellmapi"
database_id = "<your-d1-database-id>"   ← 记下这个值
```

### d. 创建 KV 命名空间

```bash
npx wrangler kv namespace create CONFIG
```

输出示例，**记下 `id`**：

```
[[kv_namespaces]]
binding = "CONFIG"
id = "<your-kv-namespace-id>"   ← 记下这个值
```

### e. 配置 wrangler.toml

编辑 `workers/wrangler.toml`，将 `database_id` 和 KV `id` 替换为你刚才获得的值：

```toml
name = "freellmapi-cf"
main = "src/index.ts"
compatibility_date = "2026-01-01"
compatibility_flags = ["nodejs_compat"]

# ---------------- D1 数据库 ----------------
[[d1_databases]]
binding = "DB"
database_name = "freellmapi"
database_id = "<your-d1-database-id>"        # ← 替换为你的 D1 ID

# ---------------- KV 命名空间 ----------------
[[kv_namespaces]]
binding = "CONFIG"
id = "<your-kv-namespace-id>"                # ← 替换为你的 KV ID

# ---------------- Durable Objects ----------------
[[durable_objects.bindings]]
name = "KEY_STATE"
class_name = "KeyState"

[[durable_objects.bindings]]
name = "SESSION"
class_name = "Session"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["KeyState", "Session"]

# ---------------- Cron Triggers ----------------
[triggers]
crons = ["0 */12 * * *"]  # 每 12 小时同步一次模型目录

# ---------------- 环境变量 ----------------
[vars]
ENVIRONMENT = "production"
SESSION_TTL_MINUTES = "30"
RATE_LIMIT_WINDOW_SECONDS = "60"
RATE_LIMIT_MAX_REQUESTS = "60"
APP_VERSION = "2.5.0"
BACKEND_URL = "https://<your-worker-subdomain>.workers.dev"
DASHBOARD_URL = "https://<your-pages-project>.pages.dev"
```

> **注意**：`BACKEND_URL` 和 `DASHBOARD_URL` 在首次部署前可以先留空或填写占位符，部署成功后再回填实际的 Workers 和 Pages URL。

### f. 设置 Secrets

以下三个 secret 是必须设置的，请用 `openssl` 生成随机值：

```bash
cd workers

# 1) 加密密钥（用于 AES-256-GCM 加密上游 API Key）
#    生成 64 位十六进制字符串（32 字节）
ENCRYPTION_KEY=$(openssl rand -hex 32)
echo "ENCRYPTION_KEY=$ENCRYPTION_KEY"
npx wrangler secret put ENCRYPTION_KEY
# 粘贴上面输出的值，回车

# 2) JWT 签名密钥（用于 Dashboard 登录会话）
JWT_SECRET=$(openssl rand -hex 32)
echo "JWT_SECRET=$JWT_SECRET"
npx wrangler secret put JWT_SECRET
# 粘贴上面输出的值，回车

# 3) 管理员启动码（首次注册管理员时需要输入，防止他人注册）
npx wrangler secret put ADMIN_BOOTSTRAP_CODE
# 输入一个你记得住的字符串，例如 <your-bootstrap-code>
```

> **重要**：请将以上所有值保存到密码管理器中。如果丢失，加密的 API Key 将无法解密。

### g. 初始化数据库并部署 Worker

```bash
cd workers

# 初始化 D1 数据库表结构
npx wrangler d1 execute freellmapi --file=./schema.sql

# 导入种子模型数据
npx wrangler d1 execute freellmapi --file=./seed-models.sql

# 部署 Worker 到 Cloudflare
npx wrangler deploy
```

部署成功后会输出：

```
Published freellmapi-cf
  https://freellmapi-cf.<your-subdomain>.workers.dev
```

记下这个 URL，这是你的后端 API 地址。

### h. 构建并部署 Pages（前端）

```bash
cd ../pages

# 构建前端
npm run build

# 部署到 Cloudflare Pages
npx wrangler pages deploy dist --project-name freellmapi-cf-dashboard
```

首次部署会提示创建 Pages 项目，按提示操作即可。部署成功后获得 Pages URL：

```
https://freellmapi-cf-dashboard.pages.dev
```

> 如果使用自定义域名，请在 Cloudflare Dashboard → Pages → 你的项目 → Custom domains 中添加。

### i. 首次登录配置

1. 打开 Pages 部署的 URL
2. 输入你设置的 `ADMIN_BOOTSTRAP_CODE`（即 `<your-bootstrap-code>`）
3. 设置管理员邮箱和密码（密码至少 8 位）
4. 进入 Dashboard
5. 在「密钥」页添加你的上游 API Key（如 Groq Key）
6. 在「密钥」页顶部创建统一 API Token（格式为 `freellmapi-xxx`），**复制保存**

---

## 数据库表结构

项目使用 Cloudflare D1（SQLite 兼容）存储所有持久化数据。完整建表语句见 `workers/schema.sql`。

| 表名 | 用途 | 关键字段 |
|------|------|---------|
| `accounts` | 管理员账号（单用户） | `email`, `password_hash` (scrypt), `password_salt` |
| `api_keys` | 加密存储的上游 API Key | `platform`, `key_ciphertext` (AES-256-GCM), `key_hint` (脱敏), `health_status` |
| `fallback_chain` | Fallback 链配置 | `position`, `platform`, `model`, `key_id` |
| `models` | 模型目录 | `id`, `platform`, `model_name`, `context_window`, `supports_tools`, `free_tier_rpm` |
| `custom_providers` | 自定义 OpenAI 兼容端点 | `label`, `base_url`, `api_key_ciphertext` |
| `custom_models` | 自定义提供商的模型映射 | `provider_id`, `model_name`, `model_type` |
| `user_tokens` | 统一 API Token（客户端用） | `token_hash` (只存哈希), `token_hint`, `request_count` |
| `sessions` | 粘性会话 | `user_token_id`, `model`, `platform`, `expires_at` |
| `request_logs` | Analytics 请求日志 | `model`, `platform`, `status_code`, `latency_ms`, `total_tokens` |
| `rate_counters` | Per-key 速率计数归档 | `key_id`, `window_start`, `window_type`, `request_count` |
| `settings` | 系统设置（键值对） | `key`, `value` |

### 安全设计要点

- 上游 API Key 使用 **AES-256-GCM** 加密后存储，密文、IV、认证标签分开存储
- 统一 Token 只存储 **哈希值**，不存明文，创建时仅显示一次
- 密码使用 **scrypt** 哈希 + 盐值存储
- 实时速率计数使用 **Durable Objects** 强一致存储，D1 表仅做归档

---

## API 端点

### OpenAI 兼容 API（客户端使用）

所有 `/v1/*` 端点需要 `Authorization: Bearer freellmapi-xxx` 鉴权。

| 方法 | 端点 | 说明 |
|------|------|------|
| `POST` | `/v1/chat/completions` | 对话补全（支持流式） |
| `GET` | `/v1/models` | 获取可用模型列表 |
| `POST` | `/v1/completions` | 文本补全（Legacy） |
| `POST` | `/v1/embeddings` | 向量嵌入 |
| `POST` | `/v1/images/generations` | 图像生成 |
| `POST` | `/v1/audio/speech` | 语音合成（TTS） |
| `POST` | `/v1/responses` | Responses API |
| `POST` | `/v1/messages` | Anthropic Messages API 兼容 |

### Dashboard API（管理面板使用）

所有 `/api/*` 端点需要登录后的 JWT Cookie 鉴权。

| 方法 | 端点 | 说明 |
|------|------|------|
| `POST` | `/api/auth/setup` | 首次设置（创建管理员） |
| `POST` | `/api/auth/login` | 登录 |
| `POST` | `/api/auth/logout` | 登出 |
| `GET` | `/api/auth/me` | 获取当前用户 |
| `GET` | `/api/keys` | 获取密钥列表 |
| `POST` | `/api/keys` | 添加密钥（返回明文一次） |
| `GET` | `/api/keys/:id` | 获取密钥详情 |
| `GET` | `/api/keys/:id/plain` | 临时获取密钥明文 |
| `PATCH` | `/api/keys/:id` | 修改密钥（标签/启用状态） |
| `DELETE` | `/api/keys/:id` | 删除密钥 |
| `POST` | `/api/keys/:id/check` | 健康检查 |
| `GET` | `/api/tokens` | 获取统一 Token 列表 |
| `POST` | `/api/tokens` | 创建统一 Token |
| `DELETE` | `/api/tokens/:id` | 删除统一 Token |
| `GET` | `/api/analytics` | 获取分析数据 |
| `GET` | `/api/models` | 获取模型管理数据 |
| `PUT` | `/api/models/:id` | 修改模型配置 |
| `GET` | `/api/fallback` | 获取 fallback 链 |
| `PUT` | `/api/fallback` | 更新 fallback 链 |
| `GET` | `/api/settings` | 获取系统设置 |
| `PUT` | `/api/settings` | 更新系统设置 |
| `GET` | `/api/about` | 获取服务信息（含版本号） |
| `GET` | `/api/meta/platforms` | 获取平台元数据 |

### 辅助端点

| 方法 | 端点 | 说明 |
|------|------|------|
| `GET` | `/` | 根路径（浏览器返回 HTML，curl 返回 JSON 元信息） |
| `GET` | `/health` | 健康检查 |
| `GET` | `/__diag` | 诊断端点（检查 bindings/secrets/表） |
| `GET` | `/__cors` | CORS 自检 |

---

## 使用示例

### 1. 对话补全（非流式）

```bash
curl https://<your-worker-subdomain>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer freellmapi-<your-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [
      {"role": "user", "content": "你好，请介绍一下你自己"}
    ]
  }'
```

### 2. 对话补全（流式）

```bash
curl https://<your-worker-subdomain>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer freellmapi-<your-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [
      {"role": "user", "content": "写一首关于春天的诗"}
    ],
    "stream": true
  }'
```

### 3. 指定具体模型

```bash
curl https://<your-worker-subdomain>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer freellmapi-<your-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "groq:llama-3.3-70b-versatile",
    "messages": [
      {"role": "user", "content": "What is 2+2?"}
    ]
  }'
```

### 4. 获取模型列表

```bash
curl https://<your-worker-subdomain>.workers.dev/v1/models \
  -H "Authorization: Bearer freellmapi-<your-token>"
```

### 5. 使用 OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    api_key="freellmapi-<your-token>",
    base_url="https://<your-worker-subdomain>.workers.dev/v1"
)

response = client.chat.completions.create(
    model="auto",
    messages=[
        {"role": "user", "content": "Hello!"}
    ]
)

print(response.choices[0].message.content)
```

### 6. 使用 Anthropic Messages API（Claude Code 兼容）

```bash
curl https://<your-worker-subdomain>.workers.dev/v1/messages \
  -H "Authorization: Bearer freellmapi-<your-token>" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "auto",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Hello, Claude!"}
    ]
  }'
```

### 7. 向量嵌入

```bash
curl https://<your-worker-subdomain>.workers.dev/v1/embeddings \
  -H "Authorization: Bearer freellmapi-<your-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "cohere:embed-english-v3.0",
    "input": "The quick brown fox jumps over the lazy dog"
  }'
```

---

## 自定义提供商配置

freellmapi-cf 支持添加任意 OpenAI 兼容的端点作为自定义提供商（如 DeepSeek、月之暗面、 Together AI 等）。

### 通过 Dashboard 添加

1. 进入「密钥」页
2. 找到「自定义提供商密钥」卡片
3. 填写：
   - **自定义 Base URL**：如 `https://api.deepseek.com/v1`
   - **自定义密钥**：你的 API Key
   - **自定义模型**：逗号分隔的模型列表，如 `deepseek-chat,deepseek-reasoner`
   - **自定义标签**：如 `DeepSeek`
4. 点击「添加自定义密钥」
5. 添加成功后会显示一次完整密钥明文，请保存

### 通过设置页动态管理

1. 进入「设置」页
2. 点击「+ 添加提供商」
3. 填写平台 ID（英文标识符，如 `deepseek`）和显示名称（如 `DeepSeek`）
4. 可选填 Base URL
5. 点击「添加」
6. 添加后可以为该平台添加模型、批量设置免费额度

### 调用自定义模型

添加后，使用 `custom:模型名` 格式调用：

```bash
curl https://<your-worker-subdomain>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer freellmapi-<your-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "custom:deepseek-chat",
    "messages": [
      {"role": "user", "content": "你好"}
    ]
  }'
```

---

## 技术栈

### 后端

| 技术 | 用途 |
|------|------|
| **Cloudflare Workers** | 边缘计算运行时 |
| **Hono** | 轻量 Web 框架（路由、中间件） |
| **Cloudflare D1** | SQLite 兼容的边缘数据库 |
| **Cloudflare KV** | 键值存储（配置缓存） |
| **Durable Objects** | 强一致状态存储（速率计数、粘性会话） |
| **Cron Triggers** | 定时任务（模型目录同步） |
| **jose** | JWT 签发与验证 |
| **Web Crypto API** | AES-256-GCM 加解密 |

### 前端

| 技术 | 用途 |
|------|------|
| **React 18** | UI 框架 |
| **Vite 5** | 构建工具与开发服务器 |
| **TypeScript** | 类型安全 |
| **TailwindCSS 3** | 原子化 CSS |
| **React Router 6** | 客户端路由 |
| **Cloudflare Pages** | 静态站点托管 |

### DevOps

| 技术 | 用途 |
|------|------|
| **GitHub Actions** | CI/CD 自动部署 |
| **wrangler CLI** | Cloudflare 资源管理 |

---

## 本地开发

### 启动后端

```bash
cd workers
npm install
npx wrangler dev
# 后端运行在 http://localhost:8787
```

### 启动前端

```bash
cd pages
npm install
npm run dev
# 前端运行在 http://localhost:5174
```

前端 `vite.config.ts` 已配置代理，`/api` 和 `/v1` 请求会自动转发到 `http://localhost:8787`。

### 本地环境变量

在 `workers/` 目录下创建 `.dev.vars` 文件（已被 .gitignore 忽略）：

```
ENCRYPTION_KEY=<64位十六进制字符串>
JWT_SECRET=<64位十六进制字符串>
ADMIN_BOOTSTRAP_CODE=<your-bootstrap-code>
```

生成密钥：

```bash
openssl rand -hex 32  # 生成 ENCRYPTION_KEY
openssl rand -hex 32  # 生成 JWT_SECRET
```

### 数据备份

```bash
# 导出整个 D1 数据库
npx wrangler d1 export freellmapi --output=./backup-$(date +%Y%m%d).sql
```

---

## 贡献指南

欢迎提交 Issue 和 Pull Request。请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 了解详细信息。

### 贡献流程

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feature/your-feature`
3. 提交更改：`git commit -m 'feat: add your feature'`
4. 推送分支：`git push origin feature/your-feature`
5. 提交 Pull Request

### 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

- `feat:` 新功能
- `fix:` Bug 修复
- `docs:` 文档更新
- `refactor:` 代码重构
- `chore:` 构建/工具变更

---

## 许可证

本项目基于 [MIT 许可证](LICENSE) 开源。

---

## 相关链接

- [更新日志](CHANGELOG.md)
- [部署指南](DEPLOY.md)
- [贡献指南](CONTRIBUTING.md)
- [免责声明](DISCLAIMER.md)
- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)
- [Hono 文档](https://hono.dev/)
