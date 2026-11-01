import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { pool } from '../apps/api/src/db/client.ts'
import { isAppendOnlyProjectProcessDocumentKind } from '../apps/api/src/modules/knowledge/knowledge-service.ts'
import { getProjectChangeAnalysis } from '../apps/api/src/modules/projects/project-change-analysis.ts'

const expected = [
  ['01-项目实施计划', 1],
  ['02-会议纪要', 2],
  ['03-周报与汇报', 3],
  ['04-市场拓展&解决方案周会待办事项汇总表', 4],
  ['05-项目交付中心周会待办事项汇总表', 5],
] as const

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

const client = await pool.connect()
try {
  const invalidFolders = await client.query<{ count: string }>(`
    WITH expected(name, ord) AS (VALUES ${expected.map((_, index) => `($${index * 2 + 1}::text,$${index * 2 + 2}::int)`).join(',')})
    SELECT count(*)::text AS count
    FROM projects p
    JOIN knowledge_bases kb ON kb.project_id=p.id
    CROSS JOIN expected e
    LEFT JOIN knowledge_folders f ON f.knowledge_base_id=kb.id
      AND f.path='01-项目管理过程/'||e.name AND f.sort_order=e.ord
    WHERE p.code NOT LIKE 'OPP-%' AND f.id IS NULL
  `, expected.flat())
  assert(Number(invalidFolders.rows[0]?.count) === 0, 'project_management_subfolder_order_invalid')

  assert(isAppendOnlyProjectProcessDocumentKind('market-solution-meeting-todos'), 'market_meeting_document_must_be_append_only')
  assert(isAppendOnlyProjectProcessDocumentKind('delivery-meeting-todos'), 'delivery_meeting_document_must_be_append_only')
  assert(!isAppendOnlyProjectProcessDocumentKind('implementation-plan'), 'implementation_plan_deduplication_changed')

  const latest = await client.query<{ id: string; expected_count: string; actual_count: string }>(`
    WITH latest AS (
      SELECT id,total_rows FROM delivery_meeting_todo_imports ORDER BY imported_at DESC,id DESC LIMIT 1
    )
    SELECT latest.id,latest.total_rows::text AS expected_count,count(t.id)::text AS actual_count
    FROM latest LEFT JOIN delivery_meeting_todos t ON t.import_id=latest.id
    GROUP BY latest.id,latest.total_rows
  `)
  if (latest.rows[0]) assert(latest.rows[0].expected_count === latest.rows[0].actual_count, 'latest_batch_row_count_mismatch')

  await client.query('BEGIN')
  const checksum = `smoke-${randomUUID()}`
  const first = await client.query<{ id: string }>('INSERT INTO delivery_meeting_todo_imports(source_name,checksum) VALUES($1,$2) RETURNING id', ['smoke-a.xlsx', checksum])
  const second = await client.query<{ id: string }>('INSERT INTO delivery_meeting_todo_imports(source_name,checksum) VALUES($1,$2) RETURNING id', ['smoke-b.xlsx', checksum])
  assert(first.rows[0]?.id !== second.rows[0]?.id, 'same_checksum_did_not_create_new_batch')
  await client.query('ROLLBACK')

  const sample = await client.query<{ project_id: string }>(`SELECT project_id FROM delivery_meeting_todos WHERE import_id=(SELECT id FROM delivery_meeting_todo_imports ORDER BY imported_at DESC,id DESC LIMIT 1) AND project_id IS NOT NULL GROUP BY project_id HAVING count(*)>0 ORDER BY count(*) DESC LIMIT 1`)
  if (sample.rows[0]) {
    const analysis = await getProjectChangeAnalysis(sample.rows[0].project_id)
    assert(analysis && analysis.items.length > 0, 'project_change_analysis_empty')
    assert(analysis.items.length <= 12, 'project_change_analysis_too_many_items')
    assert(analysis.items[0]?.category === '整体进展', 'project_change_analysis_must_start_with_overall_progress')
    assert(analysis.items.every(item => !item.detail.includes('已完成事项需要关注')), 'completed_todo_incorrectly_flagged')
    assert(new Set(analysis.items.slice(0, 4).map(item => item.category)).size >= Math.min(3, analysis.items.length), 'default_four_insights_not_multidimensional')
    assert(analysis.items.every(item => item.evidence.length > 0), 'project_change_analysis_evidence_missing')
  }

  console.log(JSON.stringify({ ok: true, checks: ['folder-order-01-to-05', 'append-only-folders-04-and-05', 'same-checksum-new-batch', 'latest-batch-row-count', 'project-change-analysis', 'default-four-multidimensional', 'analysis-evidence'] }))
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined)
  throw error
} finally {
  client.release()
  await pool.end()
}
