// Rakko 本地预览网关：把 apps/web/index.html 与 8787 的 API 放在同一个源上，
// 这样浏览器不会因为跨源把请求拦掉（服务端目前没有 CORS）。
// 用法：node scripts/ui-gateway.mjs   然后打开 http://127.0.0.1:8088
import { createServer, request as httpRequest } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.UI_PORT ?? 8088)
const API_HOST = process.env.API_HOST ?? '127.0.0.1'
const API_PORT = Number(process.env.API_PORT ?? 8787)
// 默认取仓库里的 apps/web，换目录可用 WEB_ROOT 覆盖
const WEB_ROOT = process.env.WEB_ROOT ?? fileURLToPath(new URL('../apps/web', import.meta.url))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

const server = createServer(async (req, res) => {
  const url = req.url ?? '/'
  const path = url.split('?')[0]

  // API 与事件流：整体转发，保持流式（SSE 不能被缓冲）
  if (path === '/health' || path === '/v1' || path.startsWith('/v1/')) {
    const upstream = httpRequest(
      {
        host: API_HOST,
        port: API_PORT,
        method: req.method,
        path: url,
        headers: { ...req.headers, host: `${API_HOST}:${API_PORT}` },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res) // 直接管道，不收集
      },
    )
    upstream.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'api_unreachable', detail: String(err.message) }))
    })
    req.pipe(upstream)
    return
  }

  // 静态：默认 index.html
  const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '')
  const file = join(WEB_ROOT, rel)
  if (!file.startsWith(WEB_ROOT)) {
    res.writeHead(403).end('forbidden')
    return
  }
  try {
    const body = await readFile(file)
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`未找到 ${rel}`)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Rakko UI: http://127.0.0.1:${PORT}`)
  console.log(`代理 API -> http://${API_HOST}:${API_PORT}`)
  console.log(`静态根目录: ${WEB_ROOT}`)
})
