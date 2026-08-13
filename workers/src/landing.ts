/**
 * GET /test — 宣传页 HTML
 */

export function getLandingHtml(version: string, dashboardUrl: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FreeLLM API · 统一大模型 API 路由</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a0f;--card:rgba(255,255,255,.04);--border:rgba(255,255,255,.08);--text:#f0f0f5;--muted:#8888a0;--accent:#8b5cf6;--accent2:#3b82f6;--grad:linear-gradient(135deg,#8b5cf6,#3b82f6)}
html{scroll-behavior:smooth}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC",sans-serif;background:var(--bg);color:var(--text);overflow-x:hidden;line-height:1.6}
a{color:inherit;text-decoration:none}

/* ===== 顶部导航 ===== */
.nav{position:fixed;top:0;left:0;right:0;z-index:100;backdrop-filter:blur(20px);background:rgba(10,10,15,.7);border-bottom:1px solid var(--border);transition:all .3s}
.nav-inner{max-width:1200px;margin:0 auto;padding:16px 24px;display:flex;align-items:center;justify-content:space-between}
.nav-logo{font-size:1.25rem;font-weight:700;letter-spacing:-.02em;display:flex;align-items:center;gap:8px}
.nav-logo span{background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.nav-links{display:flex;gap:32px;align-items:center}
.nav-links a{color:var(--muted);font-size:.9rem;transition:color .2s}
.nav-links a:hover{color:var(--text)}
.nav-cta{background:var(--grad);color:#fff;padding:8px 20px;border-radius:8px;font-size:.85rem;font-weight:600;transition:transform .2s,box-shadow .2s}
.nav-cta:hover{transform:translateY(-1px);box-shadow:0 4px 20px rgba(139,92,246,.4)}
@media(max-width:768px){.nav-links{display:none}.nav-cta{display:none}}

/* ===== Hero ===== */
.hero{min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;position:relative;padding:80px 24px 60px}
.hero-bg{position:absolute;inset:0;overflow:hidden;z-index:0}
.hero-bg::before{content:"";position:absolute;width:600px;height:600px;border-radius:50%;background:radial-gradient(circle,rgba(139,92,246,.15),transparent 70%);top:-200px;left:-100px;animation:float1 8s ease-in-out infinite}
.hero-bg::after{content:"";position:absolute;width:500px;height:500px;border-radius:50%;background:radial-gradient(circle,rgba(59,130,246,.12),transparent 70%);bottom:-150px;right:-50px;animation:float2 10s ease-in-out infinite}
@keyframes float1{0%,100%{transform:translate(0,0)}50%{transform:translate(30px,40px)}}
@keyframes float2{0%,100%{transform:translate(0,0)}50%{transform:translate(-30px,-40px)}}
.hero-content{position:relative;z-index:1;max-width:900px}
.hero-badge{display:inline-flex;align-items:center;gap:8px;background:rgba(139,92,246,.1);border:1px solid rgba(139,92,246,.3);padding:6px 16px;border-radius:100px;font-size:.8rem;color:#c4b5fd;margin-bottom:32px;animation:fadeInUp .6s}
.hero-badge .dot{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 8px #22c55e;animation:pulse 2s infinite}
.hero h1{font-size:3.5rem;font-weight:800;letter-spacing:-.03em;line-height:1.1;margin-bottom:24px;animation:fadeInUp .8s}
.hero h1 .grad{background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.hero p{font-size:1.15rem;color:var(--muted);max-width:600px;margin:0 auto 40px;animation:fadeInUp 1s}
.hero-btns{display:flex;gap:16px;justify-content:center;animation:fadeInUp 1.2s}
.btn-primary{background:var(--grad);color:#fff;padding:14px 32px;border-radius:10px;font-weight:600;font-size:.95rem;transition:transform .2s,box-shadow .2s}
.btn-primary:hover{transform:translateY(-2px);box-shadow:0 8px 30px rgba(139,92,246,.4)}
.btn-ghost{background:var(--card);border:1px solid var(--border);color:var(--text);padding:14px 32px;border-radius:10px;font-weight:600;font-size:.95rem;transition:all .2s}
.btn-ghost:hover{border-color:var(--accent);background:rgba(139,92,246,.1)}
@media(max-width:768px){.hero h1{font-size:2.2rem}.hero p{font-size:1rem}}

/* ===== 模型滚动条 ===== */
.marquee{overflow:hidden;padding:40px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border);background:rgba(0,0,0,.2)}
.marquee-title{text-align:center;font-size:.8rem;color:var(--muted);margin-bottom:24px;text-transform:uppercase;letter-spacing:.1em}
.marquee-track{display:flex;gap:16px;animation:scroll 40s linear infinite;width:max-content}
.marquee:hover .marquee-track{animation-play-state:paused}
.marquee-item{display:flex;align-items:center;gap:10px;padding:12px 24px;background:var(--card);border:1px solid var(--border);border-radius:100px;white-space:nowrap;font-size:.9rem;color:var(--text);transition:border-color .2s}
.marquee-item:hover{border-color:var(--accent)}
.marquee-item .icon{font-size:1.2rem}
@keyframes scroll{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
@keyframes fadeInUp{0%{opacity:0;transform:translateY(20px)}100%{opacity:1;transform:translateY(0)}}

/* ===== 统计 ===== */
.stats{max-width:1000px;margin:0 auto;padding:80px 24px;display:grid;grid-template-columns:repeat(4,1fr);gap:32px;text-align:center}
.stat-num{font-size:2.8rem;font-weight:800;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;font-family:monospace}
.stat-label{font-size:.85rem;color:var(--muted);margin-top:8px}
@media(max-width:768px){.stats{grid-template-columns:repeat(2,1fr);gap:24px}.stat-num{font-size:2rem}}

/* ===== 特性区 ===== */
.section{padding:80px 24px;max-width:1100px;margin:0 auto}
.section-title{text-align:center;font-size:2rem;font-weight:700;margin-bottom:16px}
.section-title .grad{background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.section-sub{text-align:center;color:var(--muted);font-size:1.05rem;margin-bottom:56px}
.features{display:grid;grid-template-columns:1fr 1fr;gap:24px}
.feature-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:32px;transition:all .3s;position:relative;overflow:hidden}
.feature-card::before{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:var(--grad);transform:scaleX(0);transform-origin:left;transition:transform .3s}
.feature-card:hover{transform:translateY(-4px);border-color:rgba(139,92,246,.3);box-shadow:0 12px 40px rgba(0,0,0,.3)}
.feature-card:hover::before{transform:scaleX(1)}
.feature-num{position:absolute;top:20px;right:24px;font-size:3rem;font-weight:800;color:rgba(255,255,255,.05);font-family:monospace}
.feature-icon{font-size:2rem;margin-bottom:16px}
.feature-card h3{font-size:1.15rem;font-weight:600;margin-bottom:10px}
.feature-card p{color:var(--muted);font-size:.9rem;line-height:1.7}
@media(max-width:768px){.features{grid-template-columns:1fr}}

/* ===== 能力网格 ===== */
.capabilities{display:grid;grid-template-columns:repeat(2,1fr);gap:20px}
.cap-card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:28px;transition:all .3s}
.cap-card:hover{border-color:var(--accent);transform:translateY(-2px)}
.cap-icon{width:48px;height:48px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:1.5rem;margin-bottom:16px}
.cap-card h3{font-size:1.1rem;font-weight:600;margin-bottom:8px}
.cap-card p{color:var(--muted);font-size:.88rem;line-height:1.6}
.cap-card .tags{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.cap-card .tag{font-size:.75rem;padding:4px 10px;border-radius:100px;background:rgba(139,92,246,.1);color:#c4b5fd;border:1px solid rgba(139,92,246,.2)}
@media(max-width:768px){.capabilities{grid-template-columns:1fr}}

/* ===== 代码示例 ===== */
.code-block{background:#0d0d14;border:1px solid var(--border);border-radius:12px;overflow:hidden;max-width:700px;margin:0 auto}
.code-header{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--border);background:rgba(255,255,255,.02)}
.code-dot{width:12px;height:12px;border-radius:50%}
.code-dots{display:flex;gap:6px}
.code-title{font-size:.8rem;color:var(--muted);margin-left:8px}
.code-body{padding:20px;font-family:"SF Mono","Fira Code",monospace;font-size:.82rem;line-height:1.8;overflow-x:auto}
.code-body .k{color:#c084fc}
.code-body .s{color:#86efac}
.code-body .c{color:#64748b}
.code-body .n{color:#fbbf24}

/* ===== CTA ===== */
.cta{padding:100px 24px;text-align:center;position:relative;overflow:hidden}
.cta-bg{position:absolute;inset:0;background:radial-gradient(ellipse at center,rgba(139,92,246,.1),transparent 60%)}
.cta-content{position:relative;z-index:1;max-width:700px;margin:0 auto}
.cta h2{font-size:2.5rem;font-weight:800;margin-bottom:16px}
.cta h2 .grad{background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.cta p{color:var(--muted);font-size:1.1rem;margin-bottom:40px}
@media(max-width:768px){.cta h2{font-size:1.8rem}}

/* ===== Footer ===== */
.footer{border-top:1px solid var(--border);padding:40px 24px;text-align:center;color:var(--muted);font-size:.85rem}
.footer a{color:var(--accent)}

/* ===== 动画入场 ===== */
.reveal{opacity:0;transform:translateY(30px);transition:opacity .6s,transform .6s}
.reveal.visible{opacity:1;transform:translateY(0)}
</style>
</head>
<body>

<!-- 导航 -->
<nav class="nav">
  <div class="nav-inner">
    <a class="nav-logo" href="/test">Free<span>LLM</span> API</a>
    <div class="nav-links">
      <a href="#features">特性</a>
      <a href="#capabilities">能力</a>
      <a href="#code">快速开始</a>
      <a href="${dashboardUrl}">控制台</a>
    </div>
    <a class="nav-cta" href="${dashboardUrl}">立即使用</a>
  </div>
</nav>

<!-- Hero -->
<section class="hero">
  <div class="hero-bg"></div>
  <div class="hero-content">
    <div class="hero-badge">
      <span class="dot"></span>
      v${version} · 17+ 提供商 · 免费开箱即用
    </div>
    <h1>统一大模型 API 路由<br><span class="grad">一个 Key 访问所有 AI</span></h1>
    <p>聚合 OpenAI / Claude / Gemini / DeepSeek / 智谱 / Groq / Cloudflare 等 17+ 提供商，智能路由、自动故障转移、密钥加密管理 —— OpenAI 兼容协议，零改造成本接入。</p>
    <div class="hero-btns">
      <a class="btn-primary" href="${dashboardUrl}">进入控制台</a>
      <a class="btn-ghost" href="#code">查看文档</a>
    </div>
  </div>
</section>

<!-- 模型滚动条 -->
<div class="marquee">
  <div class="marquee-title">支持的平台与模型</div>
  <div class="marquee-track">
    <div class="marquee-item"><span class="icon">🟢</span> OpenAI · GPT-4o</div>
    <div class="marquee-item"><span class="icon">🟠</span> Anthropic · Claude 3.5</div>
    <div class="marquee-item"><span class="icon">🔵</span> Google · Gemini 2.0</div>
    <div class="marquee-item"><span class="icon">🔴</span> DeepSeek · R1</div>
    <div class="marquee-item"><span class="icon">🟣</span> 智谱 · GLM-4</div>
    <div class="marquee-item"><span class="icon">⚫</span> Groq · Llama 3.3</div>
    <div class="marquee-item"><span class="icon">🟠</span> Cloudflare · Workers AI</div>
    <div class="marquee-item"><span class="icon">🟢</span> NVIDIA · NIM</div>
    <div class="marquee-item"><span class="icon">🔵</span> Cerebras · Llama 3.1</div>
    <div class="marquee-item"><span class="icon">🟡</span> SambaNova</div>
    <div class="marquee-item"><span class="icon">🟣</span> AI Horde</div>
    <!-- 复制一份用于无缝循环 -->
    <div class="marquee-item"><span class="icon">🟢</span> OpenAI · GPT-4o</div>
    <div class="marquee-item"><span class="icon">🟠</span> Anthropic · Claude 3.5</div>
    <div class="marquee-item"><span class="icon">🔵</span> Google · Gemini 2.0</div>
    <div class="marquee-item"><span class="icon">🔴</span> DeepSeek · R1</div>
    <div class="marquee-item"><span class="icon">🟣</span> 智谱 · GLM-4</div>
    <div class="marquee-item"><span class="icon">⚫</span> Groq · Llama 3.3</div>
    <div class="marquee-item"><span class="icon">🟠</span> Cloudflare · Workers AI</div>
    <div class="marquee-item"><span class="icon">🟢</span> NVIDIA · NIM</div>
    <div class="marquee-item"><span class="icon">🔵</span> Cerebras · Llama 3.1</div>
    <div class="marquee-item"><span class="icon">🟡</span> SambaNova</div>
    <div class="marquee-item"><span class="icon">🟣</span> AI Horde</div>
  </div>
</div>

<!-- 统计 -->
<section class="stats reveal">
  <div><div class="stat-num">17+</div><div class="stat-label">AI 提供商</div></div>
  <div><div class="stat-num">500+</div><div class="stat-label">模型可选</div></div>
  <div><div class="stat-num">5</div><div class="stat-label">路由策略</div></div>
  <div><div class="stat-num">99.9%</div><div class="stat-label">可用性</div></div>
</section>

<!-- 特性 -->
<section class="section" id="features">
  <h2 class="section-title reveal">不只是 API 代理 <span class="grad">是智能路由中枢</span></h2>
  <p class="section-sub reveal">从密钥管理到请求路由、从健康检查到成本分析 —— 全流程自动化</p>
  <div class="features">
    <div class="feature-card reveal">
      <div class="feature-num">01</div>
      <div class="feature-icon">🧠</div>
      <h3>智能路由策略</h3>
      <p>5 种路由模式: <b>auto</b> 自动选路、<b>fastest</b> 按延迟排序、<b>smartest</b> 按模型能力排序、<b>fusion</b> 多模型融合、<b>manual</b> 手动指定。请求自动在多个提供商间故障转移。</p>
    </div>
    <div class="feature-card reveal">
      <div class="feature-num">02</div>
      <div class="feature-icon">🔐</div>
      <h3>密钥加密管理</h3>
      <p>所有 API Key 使用 <b>AES-256-GCM</b> 加密存储，支持自定义 Base URL、密钥提示、健康检查、启用/禁用。一键同步模型列表，批量管理密钥。</p>
    </div>
    <div class="feature-card reveal">
      <div class="feature-num">03</div>
      <div class="feature-icon">📊</div>
      <h3>实时数据分析</h3>
      <p>请求成功率、延迟分布、Token 用量、成本节省预估 —— 按平台、模型、时间维度可视化分析。流式请求自动提取 usage 数据。</p>
    </div>
    <div class="feature-card reveal">
      <div class="feature-num">04</div>
      <div class="feature-icon">⚡</div>
      <h3>全协议兼容</h3>
      <p>兼容 OpenAI Chat / Completions / Embeddings / Images / Audio / Responses API，同时支持 Anthropic Messages API。现有代码零改动接入。</p>
    </div>
  </div>
</section>

<!-- 能力网格 -->
<section class="section" id="capabilities">
  <h2 class="section-title reveal">四大核心能力 <span class="grad">一个平台搞定</span></h2>
  <p class="section-sub reveal">从对话到嵌入、从流式到多模态，覆盖所有 LLM 使用场景</p>
  <div class="capabilities">
    <div class="cap-card reveal">
      <div class="cap-icon" style="background:rgba(139,92,246,.15)">💬</div>
      <h3>对话补全</h3>
      <p>支持流式/非流式响应、多轮对话、系统提示词、函数调用 (Function Calling)、工具选择。</p>
      <div class="tags"><span class="tag">Streaming</span><span class="tag">Function Call</span><span class="tag">Vision</span></div>
    </div>
    <div class="cap-card reveal">
      <div class="cap-icon" style="background:rgba(59,130,246,.15)">🔢</div>
      <h3>向量嵌入</h3>
      <p>统一嵌入 API，支持 OpenAI、Cohere 等嵌入模型，输入文本自动路由到对应提供商。</p>
      <div class="tags"><span class="tag">OpenAI</span><span class="tag">Cohere</span><span class="tag">Custom</span></div>
    </div>
    <div class="cap-card reveal">
      <div class="cap-icon" style="background:rgba(34,197,94,.15)">🎨</div>
      <h3>图像生成</h3>
      <p>文生图、图像编辑，支持 DALL·E、FLUX 等模型，统一的图像生成接口。</p>
      <div class="tags"><span class="tag">DALL·E</span><span class="tag">FLUX</span><span class="tag">URL/Base64</span></div>
    </div>
    <div class="cap-card reveal">
      <div class="cap-icon" style="background:rgba(251,191,36,.15)">🔊</div>
      <h3>语音合成</h3>
      <p>TTS 语音合成，多语言多音色，从旁白到对白，返回音频流或 Base64。</p>
      <div class="tags"><span class="tag">TTS</span><span class="tag">Multi-language</span><span class="tag">Streaming</span></div>
    </div>
  </div>
</section>

<!-- 代码示例 -->
<section class="section" id="code">
  <h2 class="section-title reveal">快速开始 <span class="grad">三行代码接入</span></h2>
  <p class="section-sub reveal">兼容 OpenAI SDK，改个 Base URL 就能用</p>
  <div class="code-block reveal">
    <div class="code-header">
      <div class="code-dots">
        <div class="code-dot" style="background:#ff5f57"></div>
        <div class="code-dot" style="background:#febc2e"></div>
        <div class="code-dot" style="background:#28c840"></div>
      </div>
      <div class="code-title">quick-start.py</div>
    </div>
    <div class="code-body"><span class="c"># pip install openai</span>
<span class="k">from</span> openai <span class="k">import</span> OpenAI

client = OpenAI(
    base_url=<span class="s">"https://api.zjkl0330.dpdns.org/v1"</span>,
    api_key=<span class="s">"your-token-here"</span>
)

response = client.chat.completions.create(
    model=<span class="s">"auto"</span>,  <span class="c"># 自动路由到最佳模型</span>
    messages=[{<span class="s">"role"</span>: <span class="s">"user"</span>, <span class="s">"content"</span>: <span class="s">"你好!"</span>}],
    stream=<span class="n">True</span>
)

<span class="k">for</span> chunk <span class="k">in</span> response:
    <span class="k">print</span>(chunk.choices[<span class="n">0</span>].delta.content, end=<span class="s">""</span>)</div>
  </div>
</section>

<!-- CTA -->
<section class="cta">
  <div class="cta-bg"></div>
  <div class="cta-content">
    <h2 class="reveal">现在就开始 <span class="grad">你的 AI 之旅</span></h2>
    <p class="reveal">17+ 提供商 / 500+ 模型 / 智能路由 / 零成本接入</p>
    <div class="hero-btns reveal">
      <a class="btn-primary" href="${dashboardUrl}">进入控制台</a>
      <a class="btn-ghost" href="https://github.com/827802685/freellmapi-cf" target="_blank">GitHub 开源</a>
    </div>
  </div>
</section>

<!-- Footer -->
<footer class="footer">
  FreeLLM API v${version} · 基于 Cloudflare Workers 构建 · <a href="https://github.com/827802685/freellmapi-cf" target="_blank">GitHub</a> · <a href="${dashboardUrl}">控制台</a>
</footer>

<script>
// 滚动入场动画
const observer = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      e.target.classList.add('visible');
    }
  });
}, { threshold: 0.1 });
document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

// 导航栏滚动效果
const nav = document.querySelector('.nav');
window.addEventListener('scroll', () => {
  if (window.scrollY > 50) {
    nav.style.background = 'rgba(10,10,15,.95)';
  } else {
    nav.style.background = 'rgba(10,10,15,.7)';
  }
});
</script>
</body>
</html>`;
}
