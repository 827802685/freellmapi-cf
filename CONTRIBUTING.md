# 贡献指南

感谢你对 freellmapi-cf 的关注！欢迎提交 Issue 和 Pull Request。

---

## 提交 Issue

提交 Issue 前，请先搜索是否已有相同问题。创建 Issue 时请包含：

- **Bug 报告**：复现步骤、预期行为、实际行为、环境信息（浏览器、操作系统）、截图（如有）
- **功能建议**：使用场景、期望效果、可能的实现方案

---

## 提交 Pull Request

### 开发流程

1. **Fork** 本仓库到你自己的 GitHub 账号
2. **克隆** 到本地：
   ```bash
   git clone https://github.com/<your-username>/freellmapi-cf.git
   cd freellmapi-cf
   ```
3. **创建特性分支**（不要直接在 main 上开发）：
   ```bash
   git checkout -b feature/your-feature
   ```
4. **安装依赖**：
   ```bash
   cd workers && npm install
   cd ../pages && npm install
   ```
5. **本地开发测试**：
   ```bash
   # 后端
   cd workers && npx wrangler dev
   # 前端（另一个终端）
   cd pages && npm run dev
   ```
6. **提交代码**（遵循提交规范，见下方）
7. **推送分支**：
   ```bash
   git push origin feature/your-feature
   ```
8. 在 GitHub 上提交 **Pull Request**，描述你的改动

### 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

| 前缀 | 用途 | 示例 |
|------|------|------|
| `feat:` | 新功能 | `feat: 添加 DeepSeek 提供商支持` |
| `fix:` | Bug 修复 | `fix: 修复亮色模式下文字不可读` |
| `docs:` | 文档更新 | `docs: 更新部署教程` |
| `refactor:` | 代码重构 | `refactor: 重构路由引擎` |
| `style:` | 代码格式 | `style: 统一缩进` |
| `test:` | 测试相关 | `test: 添加加密模块单元测试` |
| `chore:` | 构建/工具 | `chore: 升级 wrangler 到 3.91` |

### 代码规范

- **TypeScript**：后端和前端均使用 TypeScript，确保类型安全
- **类型检查**：提交前运行 `npm run typecheck` 确保无类型错误
- **命名**：变量和函数使用 camelCase，类型和接口使用 PascalCase
- **注释**：复杂逻辑请添加注释，公共 API 添加 JSDoc
- **安全**：不要在代码中硬编码任何密钥、Token、密码，使用环境变量

### 新增提供商

如果要添加新的 LLM 提供商：

1. 在 `workers/src/providers/` 下创建新的适配器文件（参考 `groq.ts`）
2. 继承 `BaseProvider` 基类，实现 `transformRequest` 和 `parseResponse` 方法
3. 在 `workers/src/providers/index.ts` 中注册
4. 在 `workers/src/types.ts` 的 `Platform` 类型中添加新平台 ID
5. 在 `workers/src/providers/index.ts` 的 `PLATFORM_LABELS` 中添加显示名称
6. 更新 `workers/seed-models.sql` 添加该平台的种子模型

---

## 项目结构

详见 [README.md](README.md) 中的目录结构说明。

后端代码在 `workers/`，前端代码在 `pages/`。

---

## 行为准则

请保持友善和尊重。我们欢迎所有背景的贡献者，不接受任何形式的骚扰或歧视行为。

---

## 许可证

提交的代码将遵循 [MIT 许可证](LICENSE)。
