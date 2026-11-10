import assert from 'node:assert/strict'
import test from 'node:test'
import { importChangeTrackingEnabled, requireImportChangeTrackingEnabled } from './import-change-feature.ts'
import { previewImplementationPlanChanges } from './project-import-change-service.ts'

test('import change tracking is enabled by default and for explicit truthy values', () => {
  assert.equal(importChangeTrackingEnabled(undefined), true)
  assert.equal(importChangeTrackingEnabled('true'), true)
  assert.equal(importChangeTrackingEnabled('1'), true)
})

test('import change tracking rejects explicit disabled values case-insensitively', () => {
  for (const value of ['false', '0', 'off', 'DISABLED', ' disabled ']) {
    assert.equal(importChangeTrackingEnabled(value), false)
    assert.throws(() => requireImportChangeTrackingEnabled(value), /import_change_tracking_disabled/)
  }
})

test('project preview service cannot bypass the disabled write gate', async () => {
  const previous = process.env.IMPORT_CHANGE_TRACKING_ENABLED
  process.env.IMPORT_CHANGE_TRACKING_ENABLED = 'false'
  try {
    await assert.rejects(previewImplementationPlanChanges('not-read', 'not-read.csv', Buffer.alloc(0)), /import_change_tracking_disabled/)
  } finally {
    if (previous === undefined) delete process.env.IMPORT_CHANGE_TRACKING_ENABLED
    else process.env.IMPORT_CHANGE_TRACKING_ENABLED = previous
  }
})
