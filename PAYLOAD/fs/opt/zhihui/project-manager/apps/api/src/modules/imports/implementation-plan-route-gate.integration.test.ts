// ICT final gate, project side — Fastify route-level test at parity with the
// opportunity side (bussiness-manager opportunity-import-change-service.integration
// .test.ts, 'ICT final gate disables preview and confirm writes while keeping reads
// available'). While IMPORT_CHANGE_TRACKING_ENABLED is explicitly disabled, the
// project implementation-plan preview/confirm routes must answer 503
// import_change_tracking_disabled without any write, while the batch-changes,
// entity-changes and latest-marker reads stay available. The flag is restored
// precisely afterwards, and the whole test runs on an isolated scratch database
// (never on the project_manager database).
//
// apps/api/src/server.ts exports nothing and listens at import time, so the
// sibling ict-server-capture-loader.mjs load hook exposes the real app and mux
// for api.inject without modifying production files.
import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { execFileSync } from 'node:child_process'
import { Pool } from 'pg'
import 'dotenv/config'

const source = process.env.DATABASE_URL ?? ''
const parsed = new URL(source)
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) throw new Error('integration_db_guard_non_local')
const admin = new URL(source); admin.pathname = '/postgres'
const name = `ict_project_route_${process.pid}_${Date.now()}`
const url = new URL(source); url.pathname = `/${name}`
const quote = (v: string) => `"${v.replaceAll('"', '""')}"`
const project = '11111111-1111-4111-8111-111111111111'
const batch = '99999999-9999-4999-8999-999999999999'
const entity = '88888888-8888-4888-8888-888888888888'
const serviceHeaders = { 'x-zh-service': 'integration-service' }
const previewUrl = `/api/projects/${project}/imports/implementation-plan/preview`
const confirmUrl = `/api/projects/${project}/imports/implementation-plan/${batch}/confirm`

type Snapshot = Record<string, string | undefined>
const snapshotEnv = (keys: string[]): Snapshot => Object.fromEntries(keys.map(key => [key, process.env[key]]))
const restoreEnv = (snapshot: Snapshot) => { for (const [key, value] of Object.entries(snapshot)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }

test('ICT final gate disables project implementation-plan preview/confirm with 503 while reads stay available', async () => {
  const control = new Pool({ connectionString: admin.toString() })
  let pool: Pool | undefined
  let capture: { app: { ready(): Promise<void>; inject(input: Record<string, unknown>): Promise<{ statusCode: number; json(): unknown }>; close(): Promise<void> }; harnessMux: { stop(): void } } | undefined
  const outer = snapshotEnv(['DATABASE_URL', 'ZH_SERVICE_TOKEN', 'PORT', 'HOST', 'PERSONAL_KNOWLEDGE_ACCOUNT_IDS', 'IMPORT_CHANGE_TRACKING_ENABLED'])
  try {
    await control.query(`CREATE DATABASE ${quote(name)}`)
    execFileSync('pnpm', ['db:migrate'], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url.toString() }, stdio: 'pipe' })
    pool = new Pool({ connectionString: url.toString() })
    await pool.query(`insert into projects(id,code,name,status) values($1,'ICT-ROUTE','ICT route gate test','planning')`, [project])

    process.env.DATABASE_URL = url.toString()
    process.env.ZH_SERVICE_TOKEN = 'integration-service'
    process.env.PORT = '0'
    process.env.HOST = '127.0.0.1'
    process.env.PERSONAL_KNOWLEDGE_ACCOUNT_IDS = ''
    await register(new URL('./ict-server-capture-loader.mjs', import.meta.url).href, import.meta.url)
    await import(new URL('../../server.ts', import.meta.url).href)
    capture = (globalThis as { __ictProjectServerCapture__?: typeof capture }).__ictProjectServerCapture__
    assert.ok(capture, 'server capture hook did not expose the app instance')
    const api = capture!.app
    await api.ready()

    const disabled = snapshotEnv(['IMPORT_CHANGE_TRACKING_ENABLED'])
    try {
      process.env.IMPORT_CHANGE_TRACKING_ENABLED = 'false'
      const preview = await api.inject({ method: 'POST', url: previewUrl, headers: serviceHeaders })
      assert.equal(preview.statusCode, 503)
      assert.deepEqual(preview.json(), { error: 'import_change_tracking_disabled' })
      const confirm = await api.inject({ method: 'POST', url: confirmUrl, headers: { ...serviceHeaders, 'content-type': 'application/json' }, payload: { previewFingerprint: 'x' } })
      assert.equal(confirm.statusCode, 503)
      assert.deepEqual(confirm.json(), { error: 'import_change_tracking_disabled' })

      const markers = await api.inject({ method: 'GET', url: `/api/projects/${project}/imports/implementation-plan/latest-markers`, headers: serviceHeaders })
      assert.equal(markers.statusCode, 200)
      assert.deepEqual(markers.json(), [])
      const changes = await api.inject({ method: 'GET', url: confirmUrl.replace('/confirm', '/changes'), headers: serviceHeaders })
      assert.equal(changes.statusCode, 404)
      assert.deepEqual(changes.json(), { error: 'import_batch_not_found' })
      const entityChanges = await api.inject({ method: 'GET', url: `/api/projects/${project}/imports/implementation-plan/entities/${entity}/changes`, headers: serviceHeaders })
      assert.equal(entityChanges.statusCode, 404)
      assert.deepEqual(entityChanges.json(), { error: 'entity_not_found' })

      assert.equal(Number((await pool!.query('select count(*) n from import_batches')).rows[0].n), 0)
      assert.equal(Number((await pool!.query(`select count(*) n from audit_logs where action in ('import.previewed','import.confirmed','import.failed')`)).rows[0].n), 0)
    } finally {
      restoreEnv(disabled)
    }

    // Contrast with the gate on: the same routes are reachable and the 503 came
    // only from the disabled gate, not from the route or database being broken.
    const boundary = 'ict-route-contrast'
    const noKindMultipart = { headers: { ...serviceHeaders, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nno kind field\r\n--${boundary}--\r\n` }
    const enabledPreview = await api.inject({ method: 'POST', url: previewUrl, ...noKindMultipart })
    assert.equal(enabledPreview.statusCode, 400)
    assert.deepEqual(enabledPreview.json(), { error: 'import_kind_required' })
    const enabledConfirm = await api.inject({ method: 'POST', url: confirmUrl, headers: { ...serviceHeaders, 'content-type': 'application/json' }, payload: { previewFingerprint: 'x' } })
    assert.equal(enabledConfirm.statusCode, 404)
    assert.deepEqual(enabledConfirm.json(), { error: 'import_batch_not_found' })
  } finally {
    restoreEnv(outer)
    try { capture?.harnessMux.stop() } catch { /* best effort */ }
    try { await capture?.app.close() } catch { /* best effort */ }
    try { await (await import('../../db/client.ts')).pool.end() } catch { /* best effort */ }
    await pool?.end().catch(() => undefined)
    await control.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`).catch(() => undefined)
    await control.end().catch(() => undefined)
  }
})
