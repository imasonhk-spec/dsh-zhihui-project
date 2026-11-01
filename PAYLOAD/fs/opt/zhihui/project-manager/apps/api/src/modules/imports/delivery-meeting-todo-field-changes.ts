// 周会待办「当前批次 vs 上一批次」字段级变化（仅 建立时间 / 截止节点）。
// 纯函数模块，不依赖数据库，便于单测；由 delivery-meeting-todo-dashboard-service 调用并附加到 items。
//
// 匹配规则（明确实现，防误配优先）：
// 1. 第一优先 sequence（序号）：当前与上一批存在相同非空序号，且「规范化标题一致」且「项目兼容」才视为同一条待办。
//    序号相同但标题不同（周表行删减导致整体错位）不匹配；多个同序号候选时按 sourceRow 先到先得。
// 2. 回退匹配：序号缺失或序号匹配失败时，按「规范化标题一致 + 项目兼容」匹配。
// 3. 项目兼容（分级比较，避免拿 projectId 和项目名直接对比）：双方都有 projectId 时按 projectId 比对；
//    否则按规范化 projectNameRaw 比对（覆盖一侧已匹配到项目、另一侧仍是原始名的真实数据）；
//    至少一方无可用项目信息时退化为仅按标题判定（与既有「连续未解决」口径一致）。
// 4. 每条上一批次待办最多被当前批次的一条待办匹配（先到先得），不会一对多。
// 变化字段与展示值：
// - establishedDate（建立时间）：原值/新值直接取日期串，空为 null。
// - deadline（截止/节点，对应 dueDate + deadlineText，源于同一个单元格）：可解析出 dueDate 时以 dueDate 为准
//   （同一节点的不同写法不算变化）；否则用 deadlineText（纯日期写法先归一化为 YYYY-MM-DD）比较。

export type MeetingTodoFieldChangeField = 'establishedDate' | 'deadline'
export type MeetingTodoFieldChange = { field: MeetingTodoFieldChangeField; label: string; oldDisplay: string | null; newDisplay: string | null }
export type MeetingTodoFieldChangeRow = { id: string; sourceRow: number; sequence?: number | null; establishedDate?: string | null; title: string; dueDate?: string | null; deadlineText?: string | null; projectId?: string | null; projectNameRaw?: string | null }
export type MeetingTodoFieldChangeMap = Map<string, MeetingTodoFieldChange[]>

export function meetingTodoFieldChanges(current: MeetingTodoFieldChangeRow[], previous: MeetingTodoFieldChangeRow[]): MeetingTodoFieldChangeMap {
  const matched = matchPreviousRows(current, previous)
  const result: MeetingTodoFieldChangeMap = new Map()
  for (const row of current) {
    const before = matched.get(row.id)
    if (!before) continue
    const changes: MeetingTodoFieldChange[] = []
    if ((row.establishedDate ?? '') !== (before.establishedDate ?? '')) changes.push({ field: 'establishedDate', label: '建立时间', oldDisplay: before.establishedDate ?? null, newDisplay: row.establishedDate ?? null })
    const oldDeadline = deadlineView(before), newDeadline = deadlineView(row)
    if ((oldDeadline ?? '') !== (newDeadline ?? '')) changes.push({ field: 'deadline', label: '截止/节点', oldDisplay: oldDeadline, newDisplay: newDeadline })
    if (changes.length) result.set(row.id, changes)
  }
  return result
}

export function matchPreviousRows(current: MeetingTodoFieldChangeRow[], previous: MeetingTodoFieldChangeRow[]): Map<string, MeetingTodoFieldChangeRow> {
  const matched = new Map<string, MeetingTodoFieldChangeRow>()
  if (!current.length || !previous.length) return matched
  const untaken = new Map(previous.map(row => [row.id, row]))
  const bySequence = new Map<number, MeetingTodoFieldChangeRow[]>()
  for (const row of previous) {
    if (row.sequence == null) continue
    const list = bySequence.get(row.sequence) ?? []
    list.push(row)
    bySequence.set(row.sequence, list)
  }
  const pick = (row: MeetingTodoFieldChangeRow, candidate: MeetingTodoFieldChangeRow) => { matched.set(row.id, candidate); untaken.delete(candidate.id) }
  for (const row of current) {
    if (row.sequence == null || !normalizeTitle(row.title)) continue
    const candidates = (bySequence.get(row.sequence) ?? []).filter(candidate => untaken.has(candidate.id) && normalizeTitle(candidate.title) === normalizeTitle(row.title) && projectCompatible(row, candidate))
    if (!candidates.length) continue
    candidates.sort((a, b) => a.sourceRow - b.sourceRow)
    pick(row, candidates[0]!)
  }
  for (const row of current) {
    if (matched.has(row.id) || !normalizeTitle(row.title)) continue
    const candidate = [...untaken.values()].filter(item => normalizeTitle(item.title) === normalizeTitle(row.title) && projectCompatible(row, item)).sort((a, b) => a.sourceRow - b.sourceRow)[0]
    if (candidate) pick(row, candidate)
  }
  return matched
}

// 分级项目比对：projectId 与项目名不能互相比（历史批次常有 projectId 为空但原始项目名相同的情况）。
function projectCompatible(a: MeetingTodoFieldChangeRow, b: MeetingTodoFieldChangeRow) {
  const infoA = projectInfo(a), infoB = projectInfo(b)
  if (infoA.id && infoB.id) return infoA.id === infoB.id
  if (infoA.raw && infoB.raw) return normalizeProjectName(infoA.raw) === normalizeProjectName(infoB.raw)
  return true // 至少一方无可用项目信息，退化为仅按标题判定（与既有「连续未解决」口径一致）
}

function projectInfo(row: MeetingTodoFieldChangeRow) {
  return { id: row.projectId ?? '', raw: normalizeTitle((row.projectNameRaw ?? '').trim()) }
}

function normalizeProjectName(value: string) {
  return value.replace(/项目$/, '') || value
}

function deadlineView(row: MeetingTodoFieldChangeRow) {
  if (row.dueDate) return row.dueDate
  const text = (row.deadlineText ?? '').trim()
  if (!text) return null
  const match = /^(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})日?$/.exec(text)
  return match ? `${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}` : text
}

function normalizeTitle(value: string) {
  return value.toLowerCase().replace(/[\s，,。；;：:（）()【】\[\]“”"']/g, '')
}
