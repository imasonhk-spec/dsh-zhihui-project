/**
 * @local/zhihui-project — 智汇·项目（客户端半）
 *
 * 骨架固定：window.__ModuleLoader__.load({ id, factory })，纯 React.createElement，无构建步骤。
 * 注册：
 *   - main key 'cap:zhihui-project'            → 项目交付中心面板（同源 iframe）
 *   - sidebar.panellist id 'cap:zhihui-project' → 左侧导航「智汇·项目」能力包行
 *   - 打开事件桥 'cappacks:open-zhihui-project' → 工作台卡片「打开」/子菜单切入主面板
 *
 * 面板加载前先向 /zhihui-sso/session 换取 zh_session（用 DSH 登录态 dsh_mu_user 同名建号），
 * 换票成功后 iframe 打开 /zhihui/project/，用户无感知，不跳智汇门户。
 */

window.__ModuleLoader__.load({
  id: '@local/zhihui-project',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useRef, useCallback } = React
    const h = React.createElement

    const PANEL_ID = 'cap:zhihui-project'
    const APP_URL = '/zhihui/project/'
    const SSO_URL = '/zhihui-sso/session?app=project'
    const OPEN_EVENT = 'cappacks:open-zhihui-project'

    /** 续期节奏：智汇闲置 2h 滑动过期，25 分钟探一次足够稳。 */
    const KEEPALIVE_MS = 25 * 60 * 1000
    /** 页面重新可见时，距上次成功超过这个间隔就先探一次。 */
    const RESUMED_PROBE_MS = 5 * 60 * 1000
    /** 挂起太久（超过这个间隔）续上票后重载 iframe，清掉子应用里的过期态。 */
    const STALE_RELOAD_MS = 30 * 60 * 1000

    const CSS = `
.zh-panel{position:relative;flex:1 1 auto;min-height:0;width:100%;height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#fff);}
.zh-body{position:relative;flex:1 1 auto;min-height:0;width:100%;}
.zh-bar{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:7px 12px;background:#fef3c7;border-bottom:1px solid #fcd34d;color:#92400e;font:12.5px/1.5 system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;}
.zh-bar span{flex:1 1 auto;}
.zh-bar button,.zh-bar a{flex:0 0 auto;padding:3px 10px;border:1px solid #f59e0b;border-radius:7px;background:#fff;color:#92400e;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;}
.zh-bar button:hover,.zh-bar a:hover{background:#fffbeb;}
.zh-frame{position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff;}
.zh-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;color:#475569;font:14px/1.6 system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;}
.zh-state b{font-size:15px;color:#0f172a;}
.zh-state span{font-size:12.5px;color:#94a3b8;max-width:520px;text-align:center;}
.zh-spin{width:22px;height:22px;border-radius:50%;border:2.5px solid #dbeafe;border-top-color:#2563eb;animation:zhSpin .9s linear infinite;}
@keyframes zhSpin{to{transform:rotate(360deg)}}
.zh-actions{display:flex;gap:8px;margin-top:6px;}
.zh-btn{display:inline-flex;align-items:center;gap:5px;padding:7px 14px;border:1px solid #e2e8f0;border-radius:9px;background:#fff;color:#475569;font:inherit;font-size:12px;font-weight:600;cursor:pointer;}
.zh-btn:hover{border-color:#cbd5e1;background:#f8fafc;}
.zh-btn.primary{background:#2563eb;border-color:#2563eb;color:#fff;}
.zh-msg{margin-top:4px;padding:8px 12px;border-radius:9px;background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;font-size:12px;max-width:640px;word-break:break-all;}
`

    function ensureStyle() {
      if (document.getElementById('zh-project-style')) return () => {}
      const el = document.createElement('style')
      el.id = 'zh-project-style'
      el.textContent = CSS
      document.head.appendChild(el)
      return () => {
        try {
          if (el.parentNode) el.parentNode.removeChild(el)
        } catch (e) {
          /* ignore */
        }
      }
    }

    function svgInfo() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: '#b45309', strokeWidth: 2, strokeLinecap: 'round', 'aria-hidden': true },
        h('circle', { cx: 12, cy: 12, r: 9 }),
        h('line', { x1: 12, y1: 8, x2: 12, y2: 13 }),
        h('circle', { cx: 12, cy: 16.5, r: 0.7, fill: '#b45309', stroke: 'none' }),
      )
    }

    /** 面板：先换会话，再挂 iframe。props 由 slot 注入，本组件不依赖。 */
    function ZhihuiProjectPanel() {
      const [phase, setPhase] = useState('sso') // sso | ready | error
      const [detail, setDetail] = useState('')
      const [needLogin, setNeedLogin] = useState(false)
      const [banner, setBanner] = useState('')
      const [nonce, setNonce] = useState(0)
      const alive = useRef(true)
      const lastOk = useRef(0)

      const handshake = useCallback(() => {
        setPhase('sso')
        setDetail('')
        setBanner('')
        setNeedLogin(false)
        fetch(SSO_URL, { credentials: 'same-origin', cache: 'no-store' })
          .then(async (response) => {
            const body = await response.json().catch(() => ({}))
            if (response.ok && body && body.ok) return body
            // 401 = DSH 登录态缺失/失效（dsh_mu_session 校验不通过），引导回工作台登录页
            if (response.status === 401) {
              const loginError = new Error((body && body.reason) || '未检测到有效的 DSH 登录态，请重新登录工作台')
              loginError.needLogin = true
              throw loginError
            }
            throw new Error((body && (body.reason || body.error)) || `HTTP ${response.status}`)
          })
          .then((body) => {
            if (!alive.current) return
            lastOk.current = Date.now()
            setPhase('ready')
            setNonce((n) => n + 1)
            void body
          })
          .catch((error) => {
            if (!alive.current) return
            setPhase('error')
            setNeedLogin(!!(error && error.needLogin))
            setDetail(String((error && error.message) || error))
          })
      }, [])

      /**
       * 静默保活：面板开着时定期重换一次票，把智汇会话的 expires_at 往后推。
       * 401 不打断当前 iframe（可能有未保存内容），只在顶部挂一条提示条。
       */
      const keepalive = useCallback(() => {
        if (!alive.current) return
        fetch(SSO_URL, { credentials: 'same-origin', cache: 'no-store' })
          .then(async (response) => {
            const body = await response.json().catch(() => ({}))
            if (response.ok && body && body.ok) {
              const gap = lastOk.current ? Date.now() - lastOk.current : 0
              lastOk.current = Date.now()
              if (!alive.current) return
              setBanner('')
              setNeedLogin(false)
              if (gap > STALE_RELOAD_MS) setNonce((n) => n + 1)
              return
            }
            if (!alive.current) return
            if (response.status === 401) {
              setNeedLogin(true)
              setBanner((body && body.reason) || 'DSH 登录态已失效，请重新登录工作台')
            } else {
              setBanner((body && (body.reason || body.error)) || `会话续期失败（HTTP ${response.status}）`)
            }
          })
          .catch(() => {
            if (alive.current) setBanner('网络异常，会话续期失败')
          })
      }, [])

      useEffect(() => {
        alive.current = true
        handshake()
        const timer = setInterval(keepalive, KEEPALIVE_MS)
        // 笔记本合盖 / 切标签页回来后，立刻补一次，避免用户回来第一下就 401
        const onWake = () => {
          if (document.visibilityState !== 'visible') return
          if (Date.now() - lastOk.current < RESUMED_PROBE_MS) return
          keepalive()
        }
        document.addEventListener('visibilitychange', onWake)
        window.addEventListener('focus', onWake)
        return () => {
          alive.current = false
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onWake)
          window.removeEventListener('focus', onWake)
        }
      }, [handshake, keepalive])

      if (phase === 'ready') {
        return h(
          'div',
          { className: 'zh-panel' },
          banner
            ? h(
                'div',
                { className: 'zh-bar' },
                h('span', null, banner),
                h('button', { type: 'button', onClick: keepalive }, '重新连接'),
                needLogin
                  ? h('a', { href: `/login?next=${encodeURIComponent(location.pathname + location.search)}` }, '登录工作台')
                  : null,
              )
            : null,
          h(
            'div',
            { className: 'zh-body' },
            h('iframe', {
              key: nonce,
              className: 'zh-frame',
              src: APP_URL,
              title: '智汇·项目',
              allow: 'clipboard-write; clipboard-read; fullscreen',
            }),
          ),
        )
      }

      if (phase === 'sso') {
        return h(
          'div',
          { className: 'zh-panel' },
          h(
            'div',
            { className: 'zh-state' },
            h('span', { className: 'zh-spin', 'aria-hidden': true }),
            h('b', null, '正在接入智汇·项目'),
            h('span', null, '使用当前 DSH 账号自动登录，无需再次输入密码…'),
          ),
        )
      }

      return h(
        'div',
        { className: 'zh-panel' },
        h(
          'div',
          { className: 'zh-state' },
            h('span', { className: 'zh-spin', style: { display: 'none' }, 'aria-hidden': true }),
            h('b', null, needLogin ? 'DSH 登录态已失效' : '智汇·项目暂时无法打开'),
            h(
              'span',
              null,
              needLogin
                ? '智汇·项目跟随 DSH 账号登录。请重新登录工作台后再打开本面板。'
                : '已登录工作台但未能换取智汇会话，通常是后端 sidecar 未就绪。',
            ),
            detail ? h('div', { className: 'zh-msg' }, detail) : null,
            h(
              'div',
              { className: 'zh-actions' },
              h('button', { className: 'zh-btn primary', type: 'button', onClick: handshake }, '重试'),
              needLogin
                ? h(
                    'a',
                    {
                      className: 'zh-btn',
                      href: `/login?next=${encodeURIComponent(location.pathname + location.search)}`,
                    },
                    '重新登录工作台',
                  )
                : h('a', { className: 'zh-btn', href: APP_URL, target: '_blank', rel: 'noopener noreferrer' }, '在新窗口打开'),
            ),
          ),
      )
    }

    /** 侧栏图标：接收 {size, active}。 */
    function PanelIcon(props) {
      const size = (props && props.size) || 18
      const active = !!(props && props.active)
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', opacity: active ? 1 : 0.75 },
        },
        h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2.5 }),
        h('line', { x1: 3, y1: 9, x2: 21, y2: 9 }),
        h('line', { x1: 9, y1: 9, x2: 9, y2: 20 }),
        h('line', { x1: 12.5, y1: 12.5, x2: 17.5, y2: 12.5 }),
        h('line', { x1: 12.5, y1: 16, x2: 16, y2: 16 }),
      )
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        const cleanups = []

        cleanups.push(
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: PANEL_ID }, ZhihuiProjectPanel),
          ),
        )

        cleanups.push(
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: '智汇·项目' }, PanelIcon),
          ),
        )

        function onOpen() {
          const layout = ctx.layout || (ctx.get && ctx.get('layout'))
          if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(PANEL_ID)
        }
        window.addEventListener(OPEN_EVENT, onOpen)
        cleanups.push(() => window.removeEventListener(OPEN_EVENT, onOpen))

        const removeStyle = ensureStyle()
        cleanups.push(removeStyle)

        return () => {
          for (const dispose of cleanups.reverse()) {
            try {
              if (typeof dispose === 'function') dispose()
            } catch (e) {
              /* ignore */
            }
          }
        }
      },
    }
  },
})
