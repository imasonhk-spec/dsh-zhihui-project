import { and, asc, eq } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { taskDependencies, tasks } from '../../db/schema.ts'
import { recordAuditLog } from '../audit/audit-log.ts'

/** List dependencies where the requested task is the successor. */
export async function listTaskDependencies(projectId: string, taskId: string) {
  await assertTask(projectId, taskId)
  const currentTaskIds = new Set((await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.projectId, projectId), eq(tasks.isCurrent, true)))).map(task => task.id))
  const rows = await db.select().from(taskDependencies)
    .where(eq(taskDependencies.successorId, taskId))
    .orderBy(asc(taskDependencies.createdAt))
  return rows.filter(row => currentTaskIds.has(row.predecessorId))
}

/** Create a predecessor -> successor edge, rejecting invalid or cyclic graphs. */
export async function createDependency(projectId: string, taskId: string, dependsOnTaskId: string) {
  await assertTask(projectId, taskId)
  await assertTask(projectId, dependsOnTaskId)
  if (taskId === dependsOnTaskId) throw new Error('dependency_self')

  const existing = await db.select({ id: taskDependencies.id })
    .from(taskDependencies)
    .where(and(eq(taskDependencies.predecessorId, dependsOnTaskId), eq(taskDependencies.successorId, taskId)))
    .limit(1)
  if (existing.length) throw new Error('dependency_duplicate')
  if (await createsCycle(projectId, dependsOnTaskId, taskId)) throw new Error('dependency_cycle')

  const [row] = await db.insert(taskDependencies).values({
    predecessorId: dependsOnTaskId,
    successorId: taskId,
  }).returning()
  await recordAuditLog({
    projectId,
    entityType: 'dependency',
    entityId: row.id,
    action: 'created',
    changes: { predecessorId: dependsOnTaskId, successorId: taskId, summary: '新增任务依赖' },
  })
  return row
}

export async function deleteDependency(projectId: string, taskId: string, dependencyId: string) {
  await assertTask(projectId, taskId)
  const [dependency] = await db.select().from(taskDependencies)
    .where(and(eq(taskDependencies.id, dependencyId), eq(taskDependencies.successorId, taskId)))
    .limit(1)
  if (!dependency) return undefined
  const [row] = await db.delete(taskDependencies).where(eq(taskDependencies.id, dependencyId)).returning()
  await recordAuditLog({
    projectId,
    entityType: 'dependency',
    entityId: dependencyId,
    action: 'deleted',
    changes: { predecessorId: dependency.predecessorId, successorId: dependency.successorId, summary: '删除任务依赖' },
  })
  return row
}

async function assertTask(projectId: string, taskId: string) {
  const [row] = await db.select({ id: tasks.id }).from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId), eq(tasks.isCurrent, true))).limit(1)
  if (!row) throw new Error('dependency_task_not_found')
}

/** Adding predecessor -> successor creates a cycle iff successor can already reach predecessor. */
async function createsCycle(projectId: string, predecessorId: string, successorId: string) {
  const projectTasks = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.projectId, projectId), eq(tasks.isCurrent, true)))
  const ids = new Set(projectTasks.map(task => task.id))
  const edges = await db.select({ predecessorId: taskDependencies.predecessorId, successorId: taskDependencies.successorId })
    .from(taskDependencies)
  const next = new Map<string, string[]>()
  for (const edge of edges) {
    if (!ids.has(edge.predecessorId) || !ids.has(edge.successorId)) continue
    const successors = next.get(edge.predecessorId) ?? []
    successors.push(edge.successorId)
    next.set(edge.predecessorId, successors)
  }
  const visited = new Set<string>()
  const pending = [successorId]
  while (pending.length) {
    const current = pending.pop()!
    if (current === predecessorId) return true
    if (visited.has(current)) continue
    visited.add(current)
    pending.push(...(next.get(current) ?? []))
  }
  return false
}
