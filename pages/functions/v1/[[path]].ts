// Pages Function: 代理 /v1/* 请求到后端 Worker
// 后端域名通过环境变量 BACKEND_URL 配置(在 Pages 项目设置里)
// 换域名时只需改一处环境变量,无需改代码

export const onRequest: PagesFunction<{ BACKEND_URL?: string }> = async (context) => {
  const BACKEND = context.env.BACKEND_URL || 'https://your-worker.your-subdomain.workers.dev';
  const targetUrl = BACKEND + '/v1/' + (context.params.path as string[]).join('/');

  const proxyReq = new Request(targetUrl, {
    method: context.request.method,
    headers: context.request.headers,
    body: ['GET', 'HEAD'].includes(context.request.method) ? undefined : context.request.body,
  });

  proxyReq.headers.delete('host');

  const res = await fetch(proxyReq);

  const newHeaders = new Headers(res.headers);
  newHeaders.set('Access-Control-Allow-Origin', '*');

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: newHeaders,
  });
};
