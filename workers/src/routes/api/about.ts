/**
 * GET /api/about
 * 公开端点:仅返回 name + version(极简信息)
 * GET /api/about/detail
 * 需鉴权:返回完整运营信息、统计、变更日志
 */

import { Hono } from 'hono';
import { requireDashboardAuth } from '../../lib/auth';
import type { Env } from '../../types';

export const aboutRoute = new Hono<{ Bindings: Env }>();

// 版本日志(每次发版在这里添加)
const CHANGELOG = [
  {
    version: '3.6.0',
    date: '2026-08-03',
    changes: {
      zh: [
        '新功能: MCP (Model Context Protocol) 支持 — 主项目内置 /mcp 端点,实现 Streamable HTTP 传输 + JSON-RPC 2.0 协议 (2025-06-18 规范)',
        '新功能: 3 个独立 MCP Worker — mcp-llm-chat (聊天/流式/模型对比)、mcp-provider-monitor (健康检查/分析/告警)、mcp-admin (密钥/Token 管理)',
        '新功能: MCP 工具集 — chat, chat_stream, list_models, get_model_info, compare_models, list_providers, health_check, get_analytics, monitor_alerts, add_key, remove_key 等 15+ 工具',
        '新功能: MCP 资源与提示 — llm://models 资源 + summarize/translate/explain_code/review_code 预设提示模板',
        '改进: CORS 头新增 Mcp-Session-Id 支持 MCP 会话管理',
        '移除: GitHub Models 平台 — GitHub Models 已于 2026-07-30 全面退役,移除 provider/模型/前端引用',
      ],
      en: [
        'Feature: MCP (Model Context Protocol) support — built-in /mcp endpoint with Streamable HTTP transport + JSON-RPC 2.0 protocol (2025-06-18 spec)',
        'Feature: 3 standalone MCP Workers — mcp-llm-chat (chat/streaming/model comparison), mcp-provider-monitor (health check/analytics/alerts), mcp-admin (key/token management)',
        'Feature: MCP toolset — chat, chat_stream, list_models, get_model_info, compare_models, list_providers, health_check, get_analytics, monitor_alerts, add_key, remove_key and 15+ tools',
        'Feature: MCP resources & prompts — llm://models resource + summarize/translate/explain_code/review_code prompt templates',
        'Improvement: CORS headers now include Mcp-Session-Id for MCP session management',
        'Removed: GitHub Models platform — GitHub Models fully retired on 2026-07-30, removed provider/models/frontend references',
      ],
    },
  },
  {
    version: '3.3.6',
    date: '2026-08-02',
    changes: {
      zh: [
        '修复: Gemini 流式截断根因 — peekFirstChunk 不识别 Gemini SSE 格式(candidates/parts),导致吞掉整个流或 15s 超时后误 fallback',
        '修复: peekFirstChunk 现在支持所有 provider 格式(OpenAI/Gemini/Anthropic/Cloudflare/Ollama)的首 chunk 检测',
        '修复: peekFirstChunk setTimeout 资源泄漏 — 所有返回路径现在都正确清理 timer',
        '修复: Playground 延迟显示负值 — 添加 Math.max(0, ...) 保护',
      ],
      en: [
        'Fix: Gemini stream truncation root cause — peekFirstChunk did not recognize Gemini SSE format (candidates/parts), causing it to swallow the entire stream or timeout after 15s and falsely fallback',
        'Fix: peekFirstChunk now supports all provider formats (OpenAI/Gemini/Anthropic/Cloudflare/Ollama) for first chunk detection',
        'Fix: peekFirstChunk setTimeout resource leak — all return paths now properly clear the timer',
        'Fix: Playground negative latency display — added Math.max(0, ...) guard',
      ],
    },
  },
  {
    version: '3.3.5',
    date: '2026-08-02',
    changes: {
      zh: [
        '修复: 长文本输出截断 — Playground max_tokens 从硬编码 500 改为可配置(默认 8192,可选到 65536)',
        '修复: 后端 max_tokens 兜底 — 客户端未设时默认 8192,避免上游默认值过低导致输出被截断',
        '修复: stream.ts stall timeout 内存泄漏 — 每次 pull 创建的 setTimeout 现在正确清理',
        '改进: Playground 工具栏新增 max_tokens 选择器,设置自动持久化',
      ],
      en: [
        'Fix: Long text output truncation — Playground max_tokens changed from hardcoded 500 to configurable (default 8192, up to 65536)',
        'Fix: Backend max_tokens fallback — default 8192 when client doesn\'t set it, preventing low upstream defaults from truncating output',
        'Fix: stream.ts stall timeout memory leak — setTimeout from each pull is now properly cleared',
        'Improvement: Playground toolbar now has max_tokens selector with auto-persistence',
      ],
    },
  },
  {
    version: '3.3.4',
    date: '2026-08-02',
    changes: {
      zh: [
        '稳定性: 流式首 chunk 探测 — 上游返回空流/超时时自动切换其他模型重新请求,客户端完全无感知',
        '稳定性: fetch 超时控制 — 30s 内未收到上游响应头自动 abort 并 fallback',
        '稳定性: 200+error body 检测 — 上游返回 200 但 body 是错误对象时自动 fallback',
        '稳定性: 流中途异常记录 — 流式传输中途断流时记录失败,影响下次路由决策',
        '覆盖: chat/completions、messages、responses 三个端点同步增强',
      ],
      en: [
        'Stability: Stream first-chunk probe — auto-fallback to another model on empty stream/timeout, transparent to client',
        'Stability: Fetch timeout control — auto-abort and fallback if no response headers within 30s',
        'Stability: 200+error body detection — auto-fallback when upstream returns 200 with error body',
        'Stability: Mid-stream error recording — log mid-stream failures for future routing decisions',
        'Coverage: All three endpoints (chat/messages/responses) enhanced simultaneously',
      ],
    },
  },
  {
    version: '3.3.3',
    date: '2026-08-02',
    changes: {
      zh: [
        '修复: API key 认证兼容 — 支持 x-api-key 头和无前缀 token,TRAE IDE 等客户端不再 401',
        '改进: "autoo" 等拼写变体自动当作 auto 处理,走 fallback chain 选路',
      ],
      en: [
        'Fix: API key auth compatibility — supports x-api-key header and prefixless tokens, TRAE IDE no longer gets 401',
        'Improvement: "autoo" and other typo variants treated as auto, routing through fallback chain',
      ],
    },
  },
  {
    version: '3.3.2',
    date: '2026-08-02',
    changes: {
      zh: [
        '改进: 模型健康状态 — 单个模型连续失败 5 次后才标记额度耗尽(rate_limited),不再一次失败即拉黑',
        '改进: 成功请求立即重置失败计数,1 小时无请求自动过期重置',
      ],
      en: [
        'Improvement: Model health — mark as rate_limited only after 5 consecutive failures, no longer blacklist on first failure',
        'Improvement: Successful request resets failure counter immediately, 1-hour TTL auto-reset on idle',
      ],
    },
  },
  {
    version: '3.3.1',
    date: '2026-08-02',
    changes: {
      zh: [
        '兼容: TRAE IDE 完整支持 — OpenAI Chat Completions 格式可直接接入,自定义配置选 OpenAI Chat Completions 即可',
        '兼容: max_completion_tokens 字段 — GPT-5/o1/o3 系列模型自动映射为 max_tokens,无需手动选模型系列',
        '兼容: stream_options.include_usage — 流式响应末尾 chunk 携带 usage 统计,TRAE/Codex/OpenAI SDK 均可获取 token 用量',
        '兼容: top_k 字段 — 支持 Gemini/DeepSeek 等模型的 top_k 超参透传',
      ],
      en: [
        'Compatibility: Full TRAE IDE support — OpenAI Chat Completions format, select Custom > OpenAI Chat Completions in TRAE settings',
        'Compatibility: max_completion_tokens field — auto-mapped to max_tokens for GPT-5/o1/o3 series models',
        'Compatibility: stream_options.include_usage — streaming responses now include usage stats in final chunk for TRAE/Codex/OpenAI SDK',
        'Compatibility: top_k field — pass-through support for Gemini/DeepSeek top_k hyperparameter',
      ],
    },
  },
  {
    version: '3.3.0',
    date: '2026-08-02',
    changes: {
      zh: [
        '新功能: /v1/responses 端点 — OpenAI Responses API 兼容,Codex CLI 可直接连接使用',
        '新功能: Responses API 流式响应 — 完整支持 response.created/output_text.delta/completed 事件流',
        '新功能: Responses API 工具调用 — 支持 function_call 流式增量 + 多轮对话上下文',
        '改进: 全局主题持久化 — 控制面板改色后点确定,所有页面 + landing page 永久同步',
      ],
      en: [
        'Feature: /v1/responses endpoint — OpenAI Responses API compatible, Codex CLI can connect directly',
        'Feature: Responses API streaming — full support for response.created/output_text.delta/completed event stream',
        'Feature: Responses API tool calls — function_call streaming deltas + multi-turn conversation context',
        'Improvement: Global theme persistence — theme changes in control panel sync to all pages + landing page permanently',
      ],
    },
  },
  {
    version: '3.2.1',
    date: '2026-07-31',
    changes: {
      zh: [
        '新功能: 全局动态背景特效 — 流动极光 + 浮动光球 + 网格纹理三层叠加,颜色跟随主题色',
        '修复: 主题定制器点击无反应 — 改为独立浮层弹窗,不再嵌入下拉菜单导致事件冲突',
        '改进: 顶部菜单全部图标替换为 SVG (调色板/太阳/月亮/地球/显示器)',
        '改进: 试玩台图标替换 (同步/时钟/橡皮擦/图片/大脑/关闭)',
        '改进: 模型页展开箭头替换为 SVG 雪佛龙图标',
      ],
      en: [
        'Feature: Global animated background — flowing aurora + floating orbs + grid texture, colors sync with theme accent',
        'Fix: Theme customizer not responding — switched to standalone floating modal, no longer nested in dropdown menu',
        'Improvement: Top menu icons replaced with SVG (palette/sun/moon/globe/monitor)',
        'Improvement: Playground icons replaced (sync/clock/eraser/image/brain/close)',
        'Improvement: Models page expand arrow replaced with SVG chevron',
      ],
    },
  },
  {
    version: '3.2.0',
    date: '2026-07-31',
    changes: {
      zh: [
        '新功能: Galaxy 主题定制器 — 7 种色彩预设(紫罗兰/海洋蓝/翡翠绿/玫瑰红/琥珀金/青碧/樱花粉)实时切换',
        '新功能: 视觉效果强度控制 — 光晕/玻璃态/渐变三档独立开关',
        '新功能: 全局玻璃态导航栏(毛玻璃模糊)+ 渐变文字标题',
        '新功能: Galaxy UI 组件库 — 涟漪按钮/渐变边框卡片/发光输入框/精美开关/加载动画',
        '改进: 所有页面加载状态替换为 Galaxy Spinner 动画',
        '改进: 所有操作按钮(删除/刷新/显示)替换为 SVG 图标,告别 emoji',
        '改进: 卡片悬浮效果、渐变描边、淡入动画全面提升视觉层次',
        '修复: 路由器指定模型只在 key 失效平台存在时,继续走 fallback 链而非返回 0 候选',
      ],
      en: [
        'Feature: Galaxy Theme Studio — 7 accent color presets (Violet/Blue/Emerald/Rose/Amber/Cyan/Pink) with live switching',
        'Feature: Visual effect intensity controls — independent toggles for Glow/Glass/Gradient',
        'Feature: Global glassmorphism navigation bar (frosted blur) + gradient text titles',
        'Feature: Galaxy UI component library — ripple buttons, gradient-border cards, glowing inputs, animated toggles, spinners',
        'Improvement: All loading states replaced with Galaxy Spinner animation',
        'Improvement: All action buttons (delete/refresh/show) replaced with SVG icons, no more emoji',
        'Improvement: Card hover effects, gradient borders, fade-in animations for visual depth',
        'Fix: Router continues to fallback chain when requested model only exists on platforms with invalid keys',
      ],
    },
  },
  {
    version: '3.1.0',
    date: '2026-07-26',
    changes: {
      zh: [
        '新功能: 图片输入支持 — auto 模式自动路由到 vision 模型(Gemini/CF/Llama 4 等)',
        '新功能: 推理模式 (reasoning_effort) — 支持 minimal/low/medium/high 四档',
        '新功能: 试玩台图片上传/粘贴/拖拽,自动压缩避免请求体超限',
        '新功能: 聊天记录本地持久化 — 离开页面再回来对话不丢失',
        '新功能: 模型同步按钮 (🔄) — 一键更新 vision/tools 标记 + 拉取最新模型',
        '新功能: 模型 vision/tools 能力启发式自动检测(覆盖 GPT/Claude/Gemini/Llama/Kimi 等)',
        '改进: 试玩台提供商列表改为后端动态获取,跟随设置页增删同步',
        '修复: 设置页提供商删不掉 — 改用 hidden_providers 隐藏机制,删除后不再自动补回',
        '修复: Google/Cloudflare provider 正确处理 image_url 多模态内容',
        '修复: 路由器 vision 过滤覆盖 sticky session / fallback chain / 模型扫描全链路',
      ],
      en: [
        'Feature: Image input support — auto mode routes to vision models (Gemini/CF/Llama 4 etc.)',
        'Feature: Reasoning mode (reasoning_effort) — supports minimal/low/medium/high',
        'Feature: Playground image upload/paste/drag-drop with auto-compression',
        'Feature: Chat history local persistence — survives page navigation',
        'Feature: Model sync button (🔄) — update vision/tools flags + fetch latest models',
        'Feature: Heuristic vision/tools capability detection (GPT/Claude/Gemini/Llama/Kimi etc.)',
        'Improvement: Playground provider list now dynamic from backend, syncs with Settings',
        'Fix: Provider deletion in Settings — hidden_providers mechanism prevents auto-recovery',
        'Fix: Google/Cloudflare providers correctly handle image_url multimodal content',
        'Fix: Router vision filtering covers sticky session / fallback chain / model scanning',
      ],
    },
  },
  {
    version: '3.0.6',
    date: '2026-07-25',
    changes: {
      zh: [
        '安全修复: CORS 改为白名单校验,禁止反射任意 Origin/null',
        '安全修复: /api/about 拆分公开/私有,敏感信息需鉴权访问',
        '安全修复: 登录接口增加输入类型校验,归一化错误响应',
        '安全修复: 登录/聊天鉴权增加 IP 速率限制',
        '安全修复: 添加 HSTS/CSP/X-Frame-Options/Permissions-Policy 安全头',
        '安全修复: 路径规范化防止编码点号穿越',
        '安全修复: /__diag 需鉴权,移除 /__cors 调试端点',
        '安全修复: 移除未实现的 /v1/responses 端点声明',
        '安全修复: 不再对外回显 backendUrl',
      ],
      en: [
        'Security: CORS switched to origin whitelist, no more wildcard/null reflection',
        'Security: /api/about split into public/private, sensitive info requires auth',
        'Security: Login endpoint input type validation, normalized error responses',
        'Security: IP-based rate limiting for login and chat auth',
        'Security: Added HSTS/CSP/X-Frame-Options/Permissions-Policy headers',
        'Security: Path normalization to prevent encoded dot traversal',
        'Security: /__diag requires auth, removed /__cors debug endpoint',
        'Security: Removed unimplemented /v1/responses endpoint declaration',
        'Security: No longer expose backendUrl externally',
      ],
    },
  },
  {
    version: '3.0.5',
    date: '2026-07-25',
    changes: {
      zh: [
        '修复流式响应丢失内容: 流结束时处理残留buffer、flush TextDecoder',
        '修复双重[DONE]标记: 去重避免客户端解析异常',
        '支持NDJSON格式上游: 非data:前缀的纯JSON行也能解析',
        '修复Anthropic格式解析: 兜底增加delta.text路径,按data.type检测格式',
        '修复AIHorde空响应: 异步任务模式完整实现(提交→轮询→返回)',
        '非流式响应空内容自动触发fallback到下一个候选',
        '修复messages路由: message_stop无条件发送,添加content_block事件',
        '修复X-Latency头名不匹配,前端空catch增加日志',
      ],
      en: [
        'Fix streaming content loss: process remaining buffer on stream end, flush TextDecoder',
        'Fix duplicate [DONE] markers: deduplicate to prevent client parsing errors',
        'Support NDJSON upstream: parse pure JSON lines without data: prefix',
        'Fix Anthropic format parsing: add delta.text fallback path, detect by data.type',
        'Fix AIHorde empty response: full async task mode (submit→poll→return)',
        'Non-streaming empty content auto-triggers fallback to next candidate',
        'Fix messages route: unconditional message_stop, add content_block events',
        'Fix X-Latency header name mismatch, add logging to empty catch blocks',
      ],
    },
  },
  {
    version: '3.0.4',
    date: '2026-07-25',
    changes: {
      zh: ['模型页面路由策略移除手动和自定义,保留均衡/最智能/最快/最稳定'],
      en: ['Models page strategy removed Manual and Custom, kept Balanced/Smartest/Fastest/Stable'],
    },
  },
  {
    version: '3.0.3',
    date: '2026-07-25',
    changes: {
      zh: ['试玩台移除手动模式,只保留自动和最快'],
      en: ['Playground removed Manual mode, only Auto and Fastest remain'],
    },
  },
  {
    version: '3.0.2',
    date: '2026-07-25',
    changes: {
      zh: ['试玩台精简路由模式: 移除"融合"和"最智能",保留自动/最快/手动'],
      en: ['Playground simplified: removed Fusion and Smartest modes, kept Auto/Fastest/Manual'],
    },
  },
  {
    version: '3.0.1',
    date: '2026-07-25',
    changes: {
      zh: [
        '修复 D1 UNION ALL 语法错误: SQLite 不允许子查询内含 ORDER BY',
        '修复 D1 UNION ALL 项数超限: 改用 IN 子句单次查询,支持任意数量平台',
      ],
      en: [
        'Fix D1 UNION ALL syntax error: SQLite disallows ORDER BY in subqueries',
        'Fix D1 UNION ALL term limit: switched to IN clause single query, supports unlimited platforms',
      ],
    },
  },
  {
    version: '3.0.0',
    date: '2026-07-25',
    changes: {
      zh: [
        '路由器 v6 重写: 并行预检所有候选(一次 DO round-trip),调度延迟从 N×100ms 降至 ~100ms',
        '修复自动选择模式优先级: 降级变体(gpt-4o-mini/claude-haiku/gemini-flash)不再和顶级模型同分',
        'buildCandidates 携带模型元数据,排序阶段 0 次额外 D1 查询',
        '所有 API 响应添加 X-Platform/X-Model/X-Latency/X-Fallback-Count 头',
        '亮色模式全面修复: select/option/textarea/placeholder 等表单元素强制使用 CSS 变量',
        '配额泄漏修复: check(只读)与 consume(扣减)分离,路由选路不再扣配额',
      ],
      en: [
        'Router v6 rewrite: parallel precheck all candidates in one DO round-trip, latency reduced from N×100ms to ~100ms',
        'Fixed auto mode priority: downgrade variants (gpt-4o-mini/claude-haiku/gemini-flash) no longer score same as top models',
        'buildCandidates carries model metadata, sorting stage requires 0 extra D1 queries',
        'All API responses now include X-Platform/X-Model/X-Latency/X-Fallback-Count headers',
        'Light mode fully fixed: select/option/textarea/placeholder form elements forced to use CSS variables',
        'Quota leak fix: check (read-only) and consume (deduct) separated, routing no longer consumes quota',
      ],
    },
  },
  {
    version: '2.9.0',
    date: '2026-07-21',
    changes: {
      zh: ['按模型级别配额追踪: 429 只屏蔽该模型,不屏蔽整个 key', '百炼等平台每个模型独立额度,用完自动切换其他模型', '模型列表标红显示额度耗尽的模型', 'models 表加 health_status 列', '成功请求自动清除模型的 rate_limited 状态'],
      en: ['Per-model quota tracking: 429 only blocks that model, not the whole key', 'Platforms like Bailian with per-model quota auto-switch to other models', 'Model list shows rate-limited models in red', 'Added health_status column to models table', 'Successful requests auto-clear model rate_limited status'],
    },
  },
  {
    version: '2.8.0',
    date: '2026-07-20',
    changes: {
      zh: ['路由修复: rate_limited 的 key 不再加入候选(不再浪费请求)', '配额追踪: 解析上游 retry-after 头,设置正确 cooldown(日限额 key 冷却到次日)', '路由修复: auto 模式无 fallback 时每 key 只选一个默认模型(候选列表不再爆炸)', '自动模型发现: cron 定时遍历 provider 调 listModels,新模型自动入库', '自动发现不覆盖管理员手动添加的模型(source=manual 优先)'],
      en: ['Router fix: rate_limited keys no longer added to candidates', 'Quota tracking: parse upstream retry-after header, set correct cooldown', 'Router fix: auto mode picks one default model per key (no more candidate explosion)', 'Auto model discovery: cron scans providers via listModels, new models auto-added', 'Auto discovery does not overwrite manually added models (source=manual priority)'],
    },
  },
  {
    version: '2.7.0',
    date: '2026-07-20',
    changes: {
      zh: ['版本日志改为后端动态返回(不再硬编码前端)', '版本号和日志随 Worker 部署自动更新', '修复亮色模式文字偏白:加深 text-primary/secondary/muted 对比度'],
      en: ['Changelog now served from backend (no longer hardcoded in frontend)', 'Version and changelog auto-update with Worker deploy', 'Fixed light mode text contrast: deepened text-primary/secondary/muted'],
    },
  },
  {
    version: '2.6.1',
    date: '2026-07-20',
    changes: {
      zh: ['修复分析页成功率:失败请求现在也记入 request_logs', '修复预估节省:流式请求现在提取 usage token', '预估节省按平台/模型参考定价计算(不再为0)', '登录后默认进入模型页而非密钥页', '修复亮色模式文字偏白对比度不足'],
      en: ['Fixed analytics success rate: failed requests now logged', 'Fixed estimated savings: streaming requests now extract usage tokens', 'Estimated savings calculated by platform pricing (no longer 0)', 'Default page after login changed to Models', 'Fixed light mode text contrast issues'],
    },
  },
  {
    version: '2.6.0',
    date: '2026-07-20',
    changes: {
      zh: ['路由策略真正生效: fastest 按延迟排序, smartest 按模型大小排序', '前端通过 X-Route-Mode 头传递路由模式', '修复非 manual 模式全发 model=auto 的问题', '密钥页加全部刷新按钮'],
      en: ['Routing strategies now work: fastest sorts by latency, smartest by model size', 'Frontend sends route mode via X-Route-Mode header', 'Fixed all non-manual modes sending model=auto', 'Added Check All button to Keys page'],
    },
  },
  {
    version: '2.5.7',
    date: '2026-07-16',
    changes: {
      zh: ['Cloudflare key 格式改为逗号分隔 (ACCOUNT_ID,API_TOKEN)', '设置页提供商卡片加刷新按钮', '关于页加版本日志'],
      en: ['Cloudflare key format changed to comma-separated', 'Added refresh button to provider cards', 'Added changelog to About page'],
    },
  },
  {
    version: '2.5.6',
    date: '2026-07-16',
    changes: {
      zh: ['修复健康检查误判(safeFetch超时问题)', '所有 Provider 健康检查改用直接 fetch', '智谱状态恢复正常'],
      en: ['Fixed health check false positives (safeFetch timeout)', 'All provider health checks now use direct fetch', 'ZAI status restored to healthy'],
    },
  },
  {
    version: '2.5.5',
    date: '2026-07-15',
    changes: {
      zh: ['Worker 反向代理: 0426 域名同时服务前端和 API', '管理面板可通过 api.zjkl0426.dpdns.org 访问'],
      en: ['Worker reverse proxy: 0426 domain serves both frontend and API', 'Dashboard accessible via api.zjkl0426.dpdns.org'],
    },
  },
  {
    version: '2.5.0',
    date: '2026-07-15',
    changes: {
      zh: ['亮色模式全面修复 (WCAG AA 标准)', 'i18n 英文翻译补全 (130+ 新 key)', '开源到 GitHub'],
      en: ['Light mode fully fixed (WCAG AA standard)', 'i18n English translations completed (130+ new key)', 'Open sourced on GitHub'],
    },
  },
  {
    version: '2.0.0',
    date: '2026-07-05',
    changes: {
      zh: ['完整重写到 Cloudflare Workers', '初始 18 个 LLM 提供商', 'AES-256-GCM 密钥加密', '管理面板 (React + Tailwind)'],
      en: ['Complete rewrite to Cloudflare Workers', 'Initial 18 LLM providers', 'AES-256-GCM key encryption', 'Dashboard (React + Tailwind)'],
    },
  },
];

// 公开端点:仅返回极简信息(name + version)
aboutRoute.get('/', async (c) => {
  const env = c.env;

  // 累计请求数(自增) — 仅计数,不泄露
  const totalKey = 'system:total_requests';
  const totalRaw = await env.CONFIG.get(totalKey);
  let total = parseInt(totalRaw || '0', 10) || 0;
  total += 1;
  c.executionCtx.waitUntil(
    env.CONFIG.put(totalKey, String(total), { expirationTtl: 60 * 60 * 24 * 365 * 5 })
  );

  return c.json({
    name: 'freellmapi-cf',
    version: env.APP_VERSION || 'dev',
    description: 'Unified LLM Router',
    runtime: 'cloudflare-workers',
    docs: {
      openai_compatible: true,
      auth: 'Bearer token in Authorization header',
    },
  });
});

// 需鉴权:返回完整运营信息、统计、变更日志
aboutRoute.get('/detail', requireDashboardAuth, async (c) => {
  const env = c.env;

  // 1) 首次部署时间(从 KV 读取,缺失则写当前)
  const startedKey = 'system:started_at';
  let startedAt = await env.CONFIG.get(startedKey);
  if (!startedAt) {
    startedAt = String(Date.now());
    await env.CONFIG.put(startedKey, startedAt, { expirationTtl: 60 * 60 * 24 * 365 * 5 });
  }
  const startedMs = parseInt(startedAt, 10) || Date.now();

  // 2) 累计请求数
  const totalKey = 'system:total_requests';
  const totalRaw = await env.CONFIG.get(totalKey);
  const total = parseInt(totalRaw || '0', 10) || 0;

  // 3) 统计 D1 中的 key / model / token 数量
  const [keysCount, modelsCount, tokensCount, usersCount] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) as c FROM api_keys').first<{ c: number }>(),
    env.DB.prepare('SELECT COUNT(*) as c FROM models').first<{ c: number }>(),
    env.DB.prepare('SELECT COUNT(*) as c FROM user_tokens WHERE enabled = 1').first<{ c: number }>(),
    env.DB.prepare('SELECT COUNT(*) as c FROM accounts').first<{ c: number }>(),
  ]);

  // 4) 统计 provider 平台
  const platforms = await env.DB.prepare(
    `SELECT platform, COUNT(*) as c, SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) as enabled
     FROM api_keys GROUP BY platform ORDER BY platform`
  ).all<{ platform: string; c: number; enabled: number }>();

  // 5) 一次最近请求时间(来自 request_logs)
  const lastReq = await env.DB.prepare(
    `SELECT created_at FROM request_logs ORDER BY id DESC LIMIT 1`
  ).first<{ created_at: number }>();

  return c.json({
    name: 'freellmapi-cf',
    version: env.APP_VERSION || 'dev',
    description: 'Unified LLM Router - 统一大模型 API 路由',
    region: (c.req as any).cf?.colo || 'unknown',
    runtime: 'cloudflare-workers',
    startedAt: startedMs,
    uptimeMs: Date.now() - startedMs,
    stats: {
      totalRequests: total,
      apiKeys: keysCount?.c || 0,
      models: modelsCount?.c || 0,
      activeTokens: tokensCount?.c || 0,
      accounts: usersCount?.c || 0,
      lastRequestAt: lastReq?.created_at || null,
    },
    platforms: (platforms.results || []).map((p: { platform: string; c: number; enabled: number }) => ({
      platform: p.platform,
      total: p.c,
      enabled: p.enabled,
    })),
    endpoints: {
      chat: '/v1/chat/completions',
      embeddings: '/v1/embeddings',
      models: '/api/models',
      keys: '/api/keys',
      tokens: '/api/tokens',
      analytics: '/api/analytics/summary',
    },
    docs: {
      openai_compatible: true,
      auth: 'Bearer token in Authorization header',
    },
    changelog: CHANGELOG,
  });
});
