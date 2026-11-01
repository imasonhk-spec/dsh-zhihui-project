import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// 候选环境由Vite服务端消费一次性票据，避免旧浏览器缓存/脚本启动顺序导致前端换票未执行。
// 未显式设置ICT_CANDIDATE_SERVER_TICKET时完全不启用，不改变默认生产/开发认证链路。
const ictCandidateTicket: Plugin = {
  name: 'ict-candidate-server-ticket',
  configureServer(server) {
    if (process.env.ICT_CANDIDATE_SERVER_TICKET !== 'true') return
    let bootstrapUsed = false
    server.middlewares.use(async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: () => void) => {
      const url = new URL(req.url ?? '/', 'http://candidate.local')
      const pathTicket = url.pathname.match(/^\/__ict-login\/([0-9a-f-]{36})\/?$/i)?.[1]
      const browserHome = url.pathname === '/' && /Edg\//i.test(req.headers['user-agent'] ?? '')
      const bootstrapTicket = !bootstrapUsed && browserHome ? process.env.ICT_CANDIDATE_BOOTSTRAP_TICKET : undefined
      const ticket = pathTicket ?? url.searchParams.get('zh_ticket') ?? bootstrapTicket
      if (!ticket || !/^[0-9a-f-]{36}$/i.test(ticket)) return next()
      try {
        const response = await fetch(`${process.env.PROJECT_API_PROXY_TARGET ?? 'http://127.0.0.1:3100'}/api/auth/ticket`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket }),
        })
        const cookie = response.headers.get('set-cookie')
        if (!response.ok || !cookie) {
          res.statusCode = response.status
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: 'candidate_ticket_exchange_failed' }))
          return
        }
        if (bootstrapTicket) bootstrapUsed = true
        res.statusCode = 302
        res.setHeader('set-cookie', cookie)
        if (pathTicket || bootstrapTicket) res.setHeader('location', '/')
        else {
          url.searchParams.delete('zh_ticket')
          res.setHeader('location', `${url.pathname}${url.search}${url.hash}`)
        }
        res.end()
      } catch {
        res.statusCode = 503
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: 'candidate_ticket_exchange_unavailable' }))
      }
    })
  },
}

// 智汇统一登录：静态数据文件（json/表格/文档）必须携带有效会话才可下载
const zhDataGuard: Plugin = {
  name: 'zh-data-guard',
  configureServer(server) {
    server.middlewares.use(async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: () => void) => {
      const pathOnly = (req.url ?? '/').split('?')[0]
      const candidateConsole = process.env.ICT_CANDIDATE_SERVER_TICKET === 'true' && pathOnly === '/ict-candidate-console.html'
      if (candidateConsole) res.setHeader('cache-control', 'no-store, max-age=0')
      if (!candidateConsole && !/\.(json|xlsx|xls|docx|doc|pdf|csv)$/i.test(pathOnly)) return next()
      try {
        const response = await fetch(`${process.env.PROJECT_API_PROXY_TARGET ?? 'http://127.0.0.1:3100'}/api/auth/me`, { headers: { cookie: req.headers.cookie ?? '' } })
        if (response.ok) return next()
      } catch { /* 校验失败按未登录处理 */ }
      res.statusCode = 401
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'AUTH_REQUIRED' }))
    })
  },
}

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  publicDir: process.env.ICT_CANDIDATE_FIXTURE_DIR || 'public',
  plugins: [ictCandidateTicket, react(), zhDataGuard],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.PROJECT_WEB_PORT ?? 3200),
    // Cloudflare quick tunnels assign a random *.trycloudflare.com hostname on
    // every restart; allow that suffix so the dev server does not 403 them.
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      '/api': process.env.PROJECT_API_PROXY_TARGET ?? 'http://127.0.0.1:3100',
      '/health': process.env.PROJECT_API_PROXY_TARGET ?? 'http://127.0.0.1:3100',
      ...(process.env.OPPORTUNITY_API_PROXY_TARGET ? { '/opp-api': { target: process.env.OPPORTUNITY_API_PROXY_TARGET, rewrite: (path: string) => path.replace(/^\/opp-api/, '/api') } } : {}),
      ...(process.env.OPPORTUNITY_NO_TENANT_API_PROXY_TARGET ? { '/opp-no-tenant-api': { target: process.env.OPPORTUNITY_NO_TENANT_API_PROXY_TARGET, rewrite: (path: string) => path.replace(/^\/opp-no-tenant-api/, '/api') } } : {}),
    },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          arco: ['@arco-design/web-react', '@arco-design/web-react/icon'],
        },
      },
    },
  },
})
