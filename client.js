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

/* PATCH:V5-o2pack-panel */
/* 授权锁屏：内联自 license-panel.js（判 usable，零票轮询） */
/* license-panel.js —— DSH 插件授权锁屏（浏览器侧，零依赖，内联进插件 client.js）
 *
 * 设计约束（改这个文件前必须读）：
 *  1. 判「能不能用」只看 state.usable，**不是** state.ready。
 *     gate.state() 的 ready = !reason && !pending —— pool=0 时它依然是 true。
 *     用 ready 判会出现「界面显示已授权，一点就 403」（方案 §4.5 / 计划 F5）。
 *  2. 软门禁只允许调 /license/state（零票端点）。禁止在轮询里探业务接口 ——
 *     业务接口走 allow() 会消耗票，用户"只是开着页面"就会把票池吃空。
 *  3. 网络故障一律 fail-open：不锁屏、只提示并继续重试。
 *     平台停服/断网不该让客户以为授权丢了（T12）。
 *  4. 不 import 任何东西：由 license_build.py 直接把本文件拼进 client.js。
 *
 * 用法（插件 client.js 里）：
 *   mountLicenseGate({ pluginId: 'huiwen-ppt', prefix: '/api/huiwen-ppt' });
 */
(function (global) {
  'use strict';

  var REASONS = {
    offline_no_license: { t: '本机尚未激活', d: '导入离线激活包，或输入激活码后联网激活。', act: true },
    no_ticket: { t: '本地授权票已用尽', d: '联网自动补票，或导入新的离线激活包。', act: true },
    expired: { t: '授权已到期', d: '请联系服务商续期。', act: true },
    revoked: { t: '授权已停用', d: '请联系服务商处理。', act: false },
    pending: { t: '授权正在审核', d: '审核通过后会自动解锁，无需重复操作。', act: false },
    unknown_plugin: { t: '该功能当前不可用', d: '插件未在授权平台登记，请联系服务商。', act: false },
    clock_tamper: { t: '系统时间异常', d: '请校正系统时间后重试（检测到时钟回拨）。', act: false },
    mismatch: { t: '授权与本插件不匹配', d: '导入的包/激活码不属于本插件。', act: true },
    bad_signature: { t: '授权数据校验失败', d: '请重新导入官方激活包。', act: true },
    gate_init_failed: { t: '授权运行时初始化失败', d: '请联系服务商并附上日志。', act: false },
  };

  /* 纯函数：把 state 判成 { lock, title, desc, canAct }
   * 单独抽出来是为了能在 node 里测（见 test/panel_lock.mjs）——
   * 这条判定逻辑出错的代价是"全部客户被锁"或"全部客户免费用"，值得单独的回归测试。 */
  function licenseGateDecision(state) {
    if (!state || typeof state !== 'object') {
      // 拿不到状态（网络/未插桩）→ fail-open，不锁
      return { lock: false, title: '', desc: '', canAct: false, unknown: true };
    }
    if (state.usable === true) return { lock: false, title: '', desc: '', canAct: false };
    // 没有 reason 但不可用，最常见的就是"票池空了"：gate.state() 在 pool=0 时
    // reason 仍是 null（票是可再补的燃料，不是终态错误）。不兜这一层的话
    // 界面会显示"原因：未知"，现场既看不懂也没法自助（导包/联网补票就能好）。
    var r = state.reason || (state.pending ? 'pending' : (state.pool === 0 ? 'no_ticket' : ''));
    var m = REASONS[r] || { t: '授权不可用', d: '原因：' + (r || '未知') + '，请联系服务商。', act: false };
    return { lock: true, reason: r, title: m.t, desc: m.d, canAct: !!m.act };
  }

  var CSS_ID = 'dshlic-style';
  var CSS = '' +
    '.dshlic-mask{position:fixed;inset:0;z-index:2147483000;background:rgba(8,10,14,.72);' +
    'backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}' +
    '.dshlic-card{width:min(520px,92vw);background:#fff;color:#1b1f24;border-radius:14px;padding:26px 26px 20px;' +
    'box-shadow:0 24px 64px rgba(0,0,0,.36)}' +
    '.dshlic-card h3{margin:0 0 6px;font-size:18px;font-weight:600}' +
    '.dshlic-desc{color:#5b6470;margin:0 0 16px;font-size:13px}' +
    '.dshlic-mc{display:flex;align-items:center;gap:8px;background:#f4f6f8;border:1px solid #e3e7ec;' +
    'border-radius:8px;padding:8px 10px;font:12px/1.4 ui-monospace,Consolas,monospace;word-break:break-all}' +
    '.dshlic-mc b{font-weight:600;color:#0f62fe;cursor:pointer}' +
    '.dshlic-row{display:flex;gap:8px;margin-top:12px}' +
    '.dshlic-row input{flex:1;min-width:0;border:1px solid #ccd3db;border-radius:8px;padding:9px 11px;font:13px ui-monospace,monospace}' +
    '.dshlic-btn{border:0;border-radius:8px;padding:9px 16px;font-size:13px;cursor:pointer;background:#0f62fe;color:#fff}' +
    '.dshlic-btn[disabled]{opacity:.55;cursor:default}' +
    '.dshlic-btn.ghost{background:#eef1f5;color:#1b1f24}' +
    '.dshlic-drop{margin-top:14px;border:1.5px dashed #ccd3db;border-radius:10px;padding:18px;text-align:center;' +
    'color:#7b8694;font-size:13px;cursor:pointer;transition:.15s}' +
    '.dshlic-drop.hot{border-color:#0f62fe;background:#f2f7ff;color:#0f62fe}' +
    '.dshlic-msg{margin-top:12px;font-size:12.5px;min-height:18px}' +
    '.dshlic-msg.err{color:#c62f2f}.dshlic-msg.ok{color:#1a7f45}' +
    '.dshlic-foot{margin-top:14px;display:flex;justify-content:space-between;align-items:center;font-size:11.5px;color:#98a2ae}' +
    '.dshlic-foot a{color:#98a2ae;text-decoration:none}';

  function injectCss(doc) {
    if (doc.getElementById(CSS_ID)) return;
    var st = doc.createElement('style');
    st.id = CSS_ID;
    st.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(st);
  }

  function el(doc, tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* 挂载锁屏。返回 { refresh, destroy } —— 幂等，可重复调用。 */
  function mountLicenseGate(opts) {
    opts = opts || {};
    var win = opts.window || (typeof window !== 'undefined' ? window : null);
    if (!win) return { refresh: function () {}, destroy: function () {} };
    var doc = opts.document || win.document;
    var pluginId = String(opts.pluginId || '');
    var prefix = String(opts.prefix || ('/api/' + pluginId)).replace(/\/+$/, '');
    var base = prefix + '/license';
    var pollMs = Math.max(5000, Number(opts.pollMs || 15000));
    var onState = typeof opts.onState === 'function' ? opts.onState : null;
    var fetchImpl = opts.fetch || (win.fetch ? win.fetch.bind(win) : null);

    var mask = null, timer = null, destroyed = false, busy = false;

    function cleanup() {
      if (timer) { win.clearInterval(timer); timer = null; }
      if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
      mask = null;
    }

    function msg(text, kind) {
      if (!mask) return;
      var m = mask.querySelector('.dshlic-msg');
      if (!m) return;
      m.textContent = text || '';
      m.className = 'dshlic-msg' + (kind ? ' ' + kind : '');
    }

    // ---- 唯一允许的自动请求：零票 state ----
    function getState() {
      if (!fetchImpl) return Promise.resolve(null);
      return fetchImpl(base + '/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plugin_id: pluginId }) })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });   // 网络故障 → null → fail-open
    }

    function post(path, body, isBinary) {
      if (!fetchImpl) return Promise.reject(new Error('no fetch'));
      var init = { method: 'POST' };
      if (isBinary) {
        init.headers = { 'content-type': 'application/octet-stream' };
        init.body = body;
      } else {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(body || {});
      }
      return fetchImpl(base + (path || ''), init).then(function (r) {
        return r.json().catch(function () { return { ok: false, error: 'bad_response' }; })
          .then(function (j) { return { status: r.status, body: j }; });
      });
    }

    function render(state) {
      var d = licenseGateDecision(state);
      if (onState) { try { onState(state, d); } catch (e) {} }
      if (!d.lock) { cleanup(); return; }
      if (mask) { // 已挂载 → 只更新文案
        var h = mask.querySelector('h3'); if (h) h.textContent = d.title;
        var p = mask.querySelector('.dshlic-desc'); if (p) p.textContent = d.desc;
        var act = mask.querySelector('.dshlic-row');
        if (act) act.style.display = d.canAct ? 'flex' : 'none';
        var drop = mask.querySelector('.dshlic-drop');
        if (drop) drop.style.display = d.canAct ? 'block' : 'none';
        return;
      }
      injectCss(doc);
      mask = el(doc, 'div', 'dshlic-mask');
      var card = el(doc, 'div', 'dshlic-card');
      card.appendChild(el(doc, 'h3', null, d.title));
      card.appendChild(el(doc, 'p', 'dshlic-desc', d.desc));

      // 机器码：现场报障的唯一凭据，必须可一键复制
      var mc = el(doc, 'div', 'dshlic-mc');
      mc.appendChild(el(doc, 'span', null, '机器码'));
      var code = el(doc, 'b', null, (state && state.machine_code) || '读取中…');
      code.title = '点击复制完整机器码';
      code.onclick = function () {
        var full = (state && state.hwid) || '';
        try {
          if (win.navigator && win.navigator.clipboard) win.navigator.clipboard.writeText(full);
          else {
            var ta = doc.createElement('textarea');
            ta.value = full; doc.body.appendChild(ta); ta.select(); doc.execCommand('copy'); doc.body.removeChild(ta);
          }
          msg('机器码已复制', 'ok');
        } catch (e) { msg('复制失败，请手动记录：' + full, 'err'); }
      };
      mc.appendChild(code);
      card.appendChild(mc);

      // 激活码
      var row = el(doc, 'div', 'dshlic-row');
      if (!d.canAct) row.style.display = 'none';
      var inp = el(doc, 'input');
      inp.placeholder = '输入激活码（lic_…）';
      inp.autocomplete = 'off';
      var btn = el(doc, 'button', 'dshlic-btn', '激活');
      btn.onclick = function () {
        var v = String(inp.value || '').trim();
        if (!v || busy) return;
        busy = true; btn.disabled = true; msg('正在激活…');
        post('/activate', { code: v }).then(function (r) {
          var st = (r.body && r.body.state) || r.body || {};
          if (r.body && r.body.ok) { msg('激活成功', 'ok'); render(st); }
          else msg('激活失败：' + ((st && st.reason) || (r.body && r.body.error) || '未知原因'), 'err');
        }).catch(function (e) { msg('激活请求失败：' + (e && e.message), 'err'); })
          .then(function () { busy = false; btn.disabled = false; });
      };
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') btn.click(); });
      row.appendChild(inp); row.appendChild(btn);
      card.appendChild(row);

      // 离线包拖拽
      var drop = el(doc, 'div', 'dshlic-drop', '把 .licpack 激活包拖到这里，或点击选择文件');
      if (!d.canAct) drop.style.display = 'none';
      var file = el(doc, 'input');
      file.type = 'file'; file.accept = '.licpack,application/octet-stream'; file.style.display = 'none';
      function doImport(f) {
        if (!f || busy) return;
        busy = true; msg('正在导入 ' + f.name + '…');
        var rd = new win.FileReader();
        rd.onload = function () {
          post('/import', rd.result, true).then(function (r) {
            var b = r.body || {};
            if (b.ok) {
              msg('导入成功：' + (b.via === 'suite' ? '套件证' : '插件证') + '，可用票 ' + (b.pool != null ? b.pool : '?'), 'ok');
              refresh();
            } else msg('导入失败：' + (b.message || b.error || '未知原因'), 'err');
          }).catch(function (e) { msg('导入请求失败：' + (e && e.message), 'err'); })
            .then(function () { busy = false; });
        };
        rd.readAsArrayBuffer(f);
      }
      drop.onclick = function () { file.click(); };
      file.onchange = function () { doImport(file.files && file.files[0]); };
      ['dragenter', 'dragover'].forEach(function (ev) {
        drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('hot'); });
      });
      ['dragleave', 'drop'].forEach(function (ev) {
        drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('hot'); });
      });
      drop.addEventListener('drop', function (e) {
        var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        doImport(f);
      });
      card.appendChild(drop);
      card.appendChild(file);

      card.appendChild(el(doc, 'div', 'dshlic-msg'));
      var foot = el(doc, 'div', 'dshlic-foot');
      foot.appendChild(el(doc, 'span', null, pluginId + ' · ' + ((state && state.server) || '')));
      var retry = el(doc, 'a', null, '刷新状态');
      retry.href = 'javascript:void(0)';
      retry.onclick = function () { refresh(); };
      foot.appendChild(retry);
      card.appendChild(foot);

      mask.appendChild(card);
      (doc.body || doc.documentElement).appendChild(mask);
    }

    function refresh() {
      if (destroyed) return Promise.resolve(null);
      return getState().then(function (st) { if (!destroyed) render(st); return st; });
    }

    function startPolling() {
      if (timer) return;
      timer = win.setInterval(function () {
        // 页面不可见时不轮询：既省请求，也避免后台标签页被打断后误判
        if (doc.visibilityState === 'hidden') return;
        refresh();
      }, pollMs);
    }

    startPolling();
    refresh();

    return {
      refresh: refresh,
      destroy: function () { destroyed = true; cleanup(); },
    };
  }

  var api = { mountLicenseGate: mountLicenseGate, licenseGateDecision: licenseGateDecision, REASONS: REASONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.mountLicenseGate = mountLicenseGate, global.licenseGateDecision = licenseGateDecision;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

try { if (typeof mountLicenseGate === 'function') mountLicenseGate({ pluginId: "zhihui-project", prefix: "/api/zhihui-project" }); } catch (e) {}
