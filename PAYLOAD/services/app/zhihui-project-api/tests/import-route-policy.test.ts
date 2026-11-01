import { strict as assert } from 'node:assert'
import { legacyImportExecutionPolicy } from '../apps/api/src/modules/imports/import-route-policy.ts'

const projectId='11111111-1111-4111-8111-111111111111'
const tasks=legacyImportExecutionPolicy(projectId,'tasks')
assert.equal(tasks.status,409)
assert.deepEqual('body' in tasks?tasks.body:undefined,{error:'task_import_requires_preview_confirm',previewEndpoint:`/api/projects/${projectId}/imports/implementation-plan/preview`})
for(const kind of ['risks','milestones','coordination','approvals','phases'])assert.equal(legacyImportExecutionPolicy(projectId,kind).status,201)
console.log('project ICT-R7-003 route policy assertions passed')
process.exit(0)
