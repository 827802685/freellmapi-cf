# freellmapi-cf 部署指南

把 freellmapi 部署到 Cloudflare Workers 的完整步骤。

## 前置条件

- 一个 Cloudflare 账号（[注册](https://dash.cloudflare.com/sign-up) 免费）
- Node.js 20+（本地用来跑 `wrangler`）
- 一个域名（可选，没域名 CF 会给你 `*.workers.dev` 的子域名）

## 第一步：克隆并安装

```bash
cd /workspace/freellmapi-cf
cd workers
npm install
cd ../pages
npm install
```

## 第二步：登录 Cloudflare

```bash
cd workers
npx wrangler login
```

会弹浏览器，让你授权 wrangler。

## 第三步：创建 Cloudflare 资源

```bash
# 1) D1 数据库
npx wrangler d1 create freellmapi
# 复制输出的 database_id,粘贴到 wrangler.toml 的 [[d1_databases]] 部分

# 2) KV 命名空间
npx wrangler kv namespace create CONFIG
# 复制输出的 id,粘贴到 wrangler.toml 的 [[kv_namespaces]] 部分
```

把上面两个 ID 填到 `workers/wrangler.toml` 里。

## 第四步：设置 Secrets

```bash
# 加密用的 32 字节 key (64 个十六进制字符)
ENCRYPTION_KEY=$(openssl rand -hex 32)
npx wrangler secret put ENCRYPTION_KEY
# 粘贴上面的值

# JWT 签名密钥
JWT_SECRET=$(openssl rand -hex 32)
npx wrangler secret put JWT_SECRET
# 粘贴上面的值

# 首次注册的启动码(防止别人注册管理员)
npx wrangler secret put ADMIN_BOOTSTRAP_CODE
# 输入一个你记得住的字符串,比如 "my-secret-2026"
```

**把这些值都记下来**,存在密码管理器里!

## 第五步：初始化数据库

```bash
npx wrangler d1 execute freellmapi --file=./schema.sql
npx wrangler d1 execute freellmapi --file=./seed-models.sql
```

## 第六步：部署后端

```bash
npx wrangler deploy
```

部署成功后会输出 worker URL,类似:
```
Published freellmapi-cf
  https://freellmapi-cf.YOUR_SUBDOMAIN.workers.dev
```

## 第七步：部署前端

```bash
cd ../pages

# 改 vite.config.ts 的 proxy target 指向你的 worker URL
# 或者直接构建后用 Pages 部署

npm run build
npx wrangler pages deploy dist --project-name freellmapi-cf-dashboard
```

第一次会提示创建 Pages project,跟着提示走就行。

## 第八步：首次登录

1. 打开 Pages 部署的 URL（比如 `https://freellmapi-cf-dashboard.pages.dev`）
2. 输入你设置的 `ADMIN_BOOTSTRAP_CODE`
3. 设置管理员邮箱 + 密码（至少 8 位）
4. 进入 Dashboard

## 第九步：添加第一个 Key

1. 进入 **API Keys** 页面
2. 点 "+ 添加 Key"
3. 选平台（比如 Groq），粘贴你的 key
4. 添加成功后,会**立刻显示完整 key 一次**（这是你**唯一一次**看到明文的机会）
5. 复制保存到密码管理器,勾选"我已保存",关掉弹窗
6. 之后在列表里只能看到脱敏的 `groq_***xxxx` 和"👁 临时显示 10 秒"按钮

## 第十步：创建统一 API Key

1. 进入 **统一 Key** 页面
2. 点 "+ 新建 Key"
3. 输入标签（可选），创建
4. **立刻复制保存**（同上面）
5. 这个 key 给客户端 SDK 用:

```bash
curl https://freellmapi-cf.YOUR_SUBDOMAIN.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer freellmapi-XXXXX..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "hello"}]
  }'
```

## 第十一步（可选）：绑定自定义域名

### 后端
在 `wrangler.toml` 的 `[env.production]` 段加:
```toml
routes = [
  { pattern = "api.yourdomain.com/*", custom_domain = true }
]
```
然后 `npx wrangler deploy --env production`

### 前端
在 Cloudflare Dashboard → Pages → 你的项目 → Custom domains → 添加

## 数据备份（强烈建议）

D1 数据不会丢，但建议每周导出一次:

```bash
# 导出整个数据库
npx wrangler d1 export freellmapi --output=./backup-$(date +%Y%m%d).sql
```

可以加 cron 任务自动备份到 R2。

## 升级

```bash
cd workers
git pull  # 或者手动同步代码
npx wrangler deploy
```

新代码会立即生效,KV/D1 数据保留。

## 常见问题

### Q: 部署后访问 500 错误
A: 检查 `wrangler tail` 输出,通常是 secrets 没设置好。

### Q: 添加 Key 后报错"no_route"
A: 还没配置 fallback chain。进 Dashboard → 选 Key 旁边应该有 fallback 配置。
也可以直接发请求指定 model 为 `groq:llama-3.3-70b` 这种具体格式。

### Q: 流式响应卡住
A: 可能是上游限流。等 1 分钟,或者换个平台 key。

### Q: Workers 免费额度够用吗？
A: 免费层每天 10 万请求,够个人用。超出后 $0.50/百万请求。
D1 免费层每天 500 万次读 + 10 万次写,完全够用。

## 监控

- Cloudflare Dashboard → Workers → Logs: 实时日志
- Cloudflare Dashboard → D1: 数据库查询统计
- Dashboard 内的 Analytics 页面: 请求统计

## 成本估算（个人使用）

| 资源 | 免费层 | 超出费用 |
|---|---|---|
| Workers 请求 | 10万/天 | $0.50/百万 |
| Workers CPU 时间 | 30s/请求 | $0.02/百万次 |
| D1 读 | 500万/天 | $0.001/百万 |
| D1 写 | 10万/天 | $1.00/百万 |
| KV 读 | 10万/天 | $0.01/百万 |
| KV 写 | 1000/天 | $1.00/百万 |
| Durable Objects 请求 | 10万/天 | $0.15/百万 |

**个人使用的实际成本: $0/月**（都在免费额度内）。
