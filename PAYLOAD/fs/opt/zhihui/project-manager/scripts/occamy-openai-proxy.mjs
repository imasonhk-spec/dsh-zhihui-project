import http from 'node:http'

const host = process.env.OCCAMY_PROXY_HOST ?? '127.0.0.1'
const port = Number(process.env.OCCAMY_PROXY_PORT ?? 11435)
const upstream = process.env.OLLAMA_OPENAI_URL ?? 'http://127.0.0.1:11434'
const allowedModel = 'occamy:1.0-q5-k-m-zhihui'

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, upstream, model: allowedModel }))
    }
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'not_found' }))
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (payload.model !== allowedModel) {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'model_not_allowed', type: 'invalid_request_error' } }))
    }
    delete payload.tools
    delete payload.tool_choice
    delete payload.parallel_tool_calls
    if (Array.isArray(payload.messages)) {
      const system = payload.messages.find(message => message?.role === 'system')
      const lastUser = [...payload.messages].reverse().find(message => message?.role === 'user')
      payload.messages = [system, lastUser].filter(Boolean)
    }
    const response = await fetch(`${upstream}${req.url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const headers = { 'content-type': response.headers.get('content-type') ?? 'application/json' }
    res.writeHead(response.status, headers)
    if (!response.body) return res.end()
    for await (const chunk of response.body) res.write(chunk)
    res.end()
  } catch (error) {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : 'proxy_error', type: 'proxy_error' } }))
  }
})

server.listen(port, host, () => console.log(`Occamy OpenAI proxy listening on http://${host}:${port}`))
