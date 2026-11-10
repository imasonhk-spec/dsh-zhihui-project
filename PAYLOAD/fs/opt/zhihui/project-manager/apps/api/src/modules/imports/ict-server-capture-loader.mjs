// Test-only ESM load hook. The project API entry (apps/api/src/server.ts) has no
// exports and starts listening at import time, so route-level tests cannot obtain
// the Fastify instance the way the opportunity side (exported default) does.
// This hook appends a capture statement to the in-memory, tsx-transpiled module
// source of server.ts only — no production file on disk is modified.
const TARGET = '/apps/api/src/server.ts'
const MARKER = 'globalThis.__ictProjectServerCapture__'

export async function initialize() {}
export async function resolve(specifier, context, nextResolve) { return nextResolve(specifier, context) }
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context)
  if (url.includes(TARGET) && result.source != null) {
    let source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    if (!source.includes(MARKER)) {
      source += `\n;${MARKER} = { app, harnessMux }\n`
      return { format: result.format ?? 'module', source, shortCircuit: true }
    }
  }
  return result
}
