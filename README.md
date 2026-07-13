# freellmapi-cf

> 把 [freellmapi](https://github.com/tashfeenahmed/freellmapi) 完整重写到 Cloudflare Workers 的版本。

## 特性

- ✅ 18 个 LLM 供应商（Groq / Google / Cerebras / OpenCode Zen / Mistral / OpenRouter / GitHub Models / Cloudflare AI / Cohere / Z.ai / NVIDIA / HuggingFace / Ollama Cloud / Kilo / Pollinations / LLM7 / OVH / AI Horde）
- ✅ OpenAI 兼容 API（`/v1/chat/completions`、`/v1/models`、`/v1/embeddings`、`/v1/completions`）
- ✅ Anthropic Messages API 兼容（`/v1/messages`，Claude Code 能直接用）
- ✅ 自动 fallback 链
- ✅ Per-key 速率跟踪（Durable Objects 强一致）
- ✅ Sticky Session（30 分钟粘性）
- ✅ 加密存储 API Key（AES-256-GCM）
- ✅ Analytics 请求日志
- ✅ Cron Triggers 每天 2 次同步远程模型目录
- ✅ 改进的 UI：添加 Key 后立刻显示一次 + 临时显示 10 秒

## 部署（GitHub Actions 自动部署 - 推荐）

### 1. Fork 或 push 到你的 GitHub

```bash
cd /workspace/freellmapi-cf
git init
git add .
git commit -m "init: freellmapi-cf"
git branch -M main
git remote add origin https://github.com/你的用户名/freellmapi-cf.git
git push -u origin main
```

### 2. 在 Cloudflare 后台创建 API Token

访问 https://dash.cloudflare.com/profile/api-tokens

- 点 "Create Token"
- 选 **"Edit Cloudflare Workers"** 模板
- 或者自定义以下权限:
  - `Account.Workers Scripts:Edit`
  - `Account.D1:Edit`
  - `Account.Account Settings:Read` (for account ID)
  - `Account.Workers KV Storage:Edit`
  - `Account.Cloudflare Pages:Edit`
- TTL 选 "1 month"（部署完可以删）
- 复制生成的 token

### 3. 在 GitHub 仓库设置 Secrets

进 `Settings → Secrets and variables → Actions → New repository secret`

**需要设置 6 个 secrets**:

| Secret 名 | 值 | 怎么获取 |
|---|---|---|
| `CF_API_TOKEN` | 上一步的 token | Cloudflare Dashboard |
| `CF_ACCOUNT_ID` | 你的 CF 账户 ID | Dashboard 右侧栏 |
| `CF_SUBDOMAIN` | workers.dev 子域名 | URL 里 `xxx.workers.dev` 的 `xxx` |
| `ENCRYPTION_KEY` | 64 位 hex | `openssl rand -hex 32` |
| `JWT_SECRET` | 64 位 hex | `openssl rand -hex 32` |
| `ADMIN_BOOTSTRAP_CODE` | 任意字符串 | 你自己定,首次注册用 |

### 4. 触发部署

两种方式:
- **自动**: push 代码到 main 分支
- **手动**: GitHub → Actions → Deploy to Cloudflare → Run workflow

部署完成后,你会看到:
- Workers URL: `https://freellmapi-cf.你的子域名.workers.dev`
- Pages URL: `https://freellmapi-cf-dashboard.pages.dev`

### 5. 首次登录

1. 打开 Pages URL
2. 输入 `ADMIN_BOOTSTRAP_CODE`
3. 设置管理员邮箱和密码
4. 进 Dashboard,添加你的 API Key

## 本地开发

```bash
# 后端
cd workers
npm install
npx wrangler dev

# 前端 (另一个终端)
cd pages
npm install
npm run dev
```

前端 `vite.config.ts` 已经配置了 proxy,`/api` 和 `/v1` 会转到 `localhost:8787`。

## 架构

```
Cloudflare Workers (Hono)
├── D1 (SQLite)         - 账号、Key 密文、Analytics、配置
├── KV                   - 配置缓存
├── Durable Objects      - Per-key 速率、Session
└── Cron Triggers        - 模型目录同步
```

## 目录结构

```
freellmapi-cf/
├── workers/                # Cloudflare Workers 后端
│   ├── src/
│   │   ├── index.ts
│   │   ├── types.ts
│   │   ├── routes/
│   │   ├── providers/
│   │   ├── lib/
│   │   └── durable-objects/
│   ├── schema.sql
│   ├── seed-models.sql
│   └── wrangler.toml
├── pages/                  # Cloudflare Pages 前端
│   └── src/
│       ├── pages/
│       │   ├── Keys.tsx    # ⭐ 改进的"添加 Key"UI
│       │   ├── Tokens.tsx
│       │   ├── Analytics.tsx
│       │   └── Login.tsx
│       └── lib/
├── .github/workflows/
│   └── deploy.yml          # 自动部署
└── DEPLOY.md               # 详细文档
```

## ⭐ UI 改进（你最关心的部分）

原版添加 Key 后看不到自己输入的 key。freellmapi-cf 解决了:

### 添加 Key 时
1. 输入 key
2. 点"添加"
3. **弹窗立刻显示完整 key 明文**（**唯一一次**机会）
4. 5 秒倒计时 + 强制勾选"我已保存"才能关

### 列表查看
- 默认显示 `groq_***mnop`
- 👁 临时显示 10 秒（自动隐藏）
- 📋 一键复制
- 🔄 立即健康检查
- ⏸ 启用/禁用
- 🗑 删除

## 许可

MIT
