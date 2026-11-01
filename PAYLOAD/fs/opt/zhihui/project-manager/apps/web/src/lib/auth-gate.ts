/**
 * 智汇统一登录前端守卫：
 * 1. 携带一次性票据（?zh_ticket=）时先向本应用后端换取会话 Cookie；
 * 2. 校验 /auth/me，无会话则跳转智汇门户登录页（带回跳参数）。
 * 在 React 渲染之前执行，未登录不会渲染任何业务页面。
 */
export async function ensureAuth(app: string, apiBase = ''): Promise<void> {
  const params = new URLSearchParams(location.search)
  const ticket = params.get('zh_ticket')
  if (ticket) {
    params.delete('zh_ticket')
    const qs = params.toString()
    history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash)
    try {
      await fetch(`${apiBase}/auth/ticket`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket }),
      })
    } catch { /* 换取失败交给后续 me 检查统一跳登录 */ }
  }
  try {
    const me = await fetch(`${apiBase}/auth/me`)
    if (me.ok) return
  } catch { /* 接口不可达也走跳转，避免白屏 */ }
  let portalUrl = ''
  try {
    const res = await fetch(`${apiBase}/auth/portal`)
    if (res.ok) portalUrl = String((await res.json() as { portalUrl?: string }).portalUrl ?? '')
  } catch { /* 使用回退地址 */ }
  const dynamicHosts = new Set(['10.18.105.88', '10.18.23.15', '10.18.23.82', '10.18.23.73', '192.168.8.103', '192.168.8.102', '100.73.194.117', 'localhost', '127.0.0.1'])
  const target = dynamicHosts.has(location.hostname)
    ? `${location.protocol}//${location.hostname}:3300`
    : portalUrl || `${location.protocol}//${location.hostname}:3300`
  location.replace(`${target}/?app=${encodeURIComponent(app)}&to=${encodeURIComponent(location.origin)}`)
  await new Promise(() => { /* 阻断启动，等待跳转 */ })
}
