/**
 * @local/zhihui-project — 智汇·项目（宿主半）
 *
 * 职责：
 *   1. 按 CAPABILITY-PACK-API v1.0 向工作台注册能力包清单（id / entryKey 以 cap: 前缀）。
 *   2. 提供子前缀路由 /api/zhihui-project（包身份探测 + sidecar 健康检查），供冒烟验收使用。
 *
 * 前端页面与接口由同源反代提供：
 *   /zhihui/project/        → 127.0.0.1:3200（静态 + /api 反代）
 *   /zhihui-sso/session     → 127.0.0.1:3220（用 dsh_mu_user 换 zh_session）
 *
 * 零第三方依赖：仅 Node 内置模块。
 */

export const MANIFEST = {
  id: 'zhihui-project',
  title: '智汇·项目',
  description: '项目交付中心：组合总览、任务/里程碑/风险/协调单/审批、周报与 AI 助手',
  entryKey: 'cap:zhihui-project',
  order: 30,
  icon: '📋',
  category: '项目管理',
  version: 'v0.2.0',
  tags: ['项目交付', '里程碑', '风险', '协调单', '周报'],
  subs: ['组合总览', '项目详情', '任务与里程碑', '风险与协调', 'AI 助手'],
  openEvent: 'cappacks:open-zhihui-project',
}

const APP_URL = '/zhihui/project/'
const SSO_URL = '/zhihui-sso/session?app=project'
const HEALTH_URL = 'http://127.0.0.1:3200/zhihui/project/health'

/** webServer 必须声明注入（Cordis 门禁），workbenchCapabilities 走 ctx.get 可选依赖。 */
import { installLicense } from './license-http.mjs'; /* PATCH:V5-o2pack-import */
export const inject = ['webServer']

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(payload)
  } catch {
    /* 连接已关闭 */
  }
}

async function probe(url, timeoutMs = 2500) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    return { ok: response.ok, status: response.status }
  } catch (error) {
    return { ok: false, status: 0, error: String((error && error.message) || error) }
  } finally {
    clearTimeout(timer)
  }
}

export function apply(ctx, _config) {
  const disposers = []

  /* PATCH:V5-o2pack-apply */
  // 授权门禁：本插件自带授权运行时，不依赖工作台；apply 阶段绝不 throw
  const __lic = installLicense(ctx, { pluginId: 'zhihui-project', prefix: '/api/zhihui-project' });
  try { disposers.push(() => { try { __lic.gate.flush(); } catch {} }); } catch {}

  /* ---- 1. 子前缀路由：包身份 + sidecar 探活 ---- */
  try {
    const ws = ctx.webServer || (ctx.get && ctx.get('webServer'))
    if (ws && typeof ws.register === 'function') {
      disposers.push(
        ws.register({
          kind: 'prefix',
          path: '/api/zhihui-project',
          handler(req, res) {
            if (__lic.guard(req, res)) return; /* PATCH:V5-o2pack-guard */
            const url = new URL(req.url || '/', 'http://127.0.0.1')
            const rest = url.pathname.replace(/^\/api\/zhihui-project/, '').replace(/\/$/, '')
            if (rest === '' || rest === '/health') {
              probe(HEALTH_URL)
                .then((upstream) => {
                  sendJson(res, upstream.ok ? 200 : 503, {
                    ok: upstream.ok,
                    package: MANIFEST.id,
                    entryKey: MANIFEST.entryKey,
                    appUrl: APP_URL,
                    ssoUrl: SSO_URL,
                    upstream,
                  })
                })
                .catch((error) => sendJson(res, 500, { ok: false, error: String(error) }))
              return
            }
            sendJson(res, 404, { ok: false, error: 'NOT_FOUND' })
          },
        }),
      )
    }
  } catch {
    /* webServer 不可用时仅保留能力注册 */
  }

  /* ---- 2. 能力包清单注册（工作台框架可能交错 apply，未就绪则延迟重试 ≈3s） ---- */
  try {
    let registered = null
    const attempt = () => {
      let wc = null
      try {
        wc = ctx.get && ctx.get('workbenchCapabilities')
      } catch {
        wc = null
      }
      if (wc && typeof wc.register === 'function') {
        try {
          wc.register(MANIFEST)
          registered = wc
          return true
        } catch {
          return false
        }
      }
      return false
    }
    if (attempt()) {
      disposers.push(() => {
        try {
          if (registered && typeof registered.unregister === 'function') registered.unregister(MANIFEST.id)
        } catch {
          /* ignore */
        }
      })
    } else {
      let tries = 0
      const timer = setInterval(() => {
        tries += 1
        if (attempt() || tries >= 20) clearInterval(timer)
      }, 150)
      disposers.push(() => clearInterval(timer))
      disposers.push(() => {
        try {
          if (registered && typeof registered.unregister === 'function') registered.unregister(MANIFEST.id)
        } catch {
          /* ignore */
        }
      })
    }
  } catch {
    /* 工作台框架未启用时跳过注册 */
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* ignore */
      }
    }
  }
}

export default { inject, apply }
