import { strict as assert } from 'node:assert'
import { normalizeParentWbsCode, taskUpdatePatch } from '../apps/api/src/modules/imports/project-import-change-service.ts'

// ICT-R7-001 red before fix: omitted fields were materialized as null/default in the UPDATE.
const omitted = taskUpdatePatch({ wbsCode: '1.1', name: '保留名称', parentWbsCode: '1' })
assert.deepEqual(omitted, { name: '保留名称' })
const cleared = taskUpdatePatch({ wbsCode: '1.1', name: '保留名称', vendor: null, parentWbsCode: '1' })
assert.equal(cleared.vendor, null)
assert.equal('ownerName' in cleared, false)

// ICT-R7-002 red before fix: parentId caused null while derived WBS was "1".
assert.equal(normalizeParentWbsCode(' １ '), '1')
assert.equal(normalizeParentWbsCode('   '), null)
assert.equal(normalizeParentWbsCode(null), null)
assert.equal(normalizeParentWbsCode('1'), normalizeParentWbsCode(' １ '))
console.log('project ICT-R7-001/002 regression assertions passed')
