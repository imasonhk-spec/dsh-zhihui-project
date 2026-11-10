export type ProgressTask = {
  id: string
  phaseId: string | null
  parentId: string | null
  status: string
  priority: string
  progress: number
}

export type ProgressPhase = { id: string; name: string }

export type ModuleProgress = {
  key: string
  name: string
  taskCount: number
  completedCount: number
  progress: number
  tasks: ProgressTask[]
}

export type WbsProgressSummary = {
  modules: ModuleProgress[]
  tasks: ProgressTask[]
  overallProgress: number
  completedCount: number
  highPriorityModules: ModuleProgress[]
  highPriorityProgress: number
  highPriorityCompletedCount: number
}

/**
 * 项目详细任务统计口径：
 * - 一级模块来自实施计划“详细实施计划（WBS分解）”Sheet 导入后的 phase。
 * - 模块名按 NFKC、首尾空白和连续空白归一化后合并，展示保留首次出现的名称。
 * - 每个一级模块的进度按模块内全部 WBS 任务等权平均，整体进度再对一级模块等权平均。
 * - 一级模块内包含任一 high/critical WBS 时，该模块计入高优先级模块；高优进度对这些模块等权平均。
 * - 未关联一级模块的手工任务不进入实施计划范围统计。
 */
export function summarizeWbsProgress(tasks: ProgressTask[], phases: ProgressPhase[]): WbsProgressSummary {
  const phaseNames = new Map(phases.map(phase => [phase.id, phase.name.trim()]))
  const groups = new Map<string, { name: string; tasks: ProgressTask[] }>()

  for (const task of tasks) {
    if (!task.phaseId) continue
    const name = phaseNames.get(task.phaseId)
    if (!name) continue
    const key = normalizeModuleName(name)
    if (!key || ['/', '-', '—', '无', '未填写'].includes(key)) continue
    const group = groups.get(key) ?? { name: normalizeDisplayName(name), tasks: [] }
    group.tasks.push(task)
    groups.set(key, group)
  }

  const modules = [...groups.entries()].map(([key, group]) => ({
    key,
    name: group.name,
    taskCount: group.tasks.length,
    completedCount: group.tasks.filter(isCompleted).length,
    progress: averageProgress(group.tasks),
    tasks: group.tasks,
  }))
  const scopedTasks = modules.flatMap(module => module.tasks)
  const highPriorityModules = modules.filter(module => module.tasks.some(task => task.priority === 'high' || task.priority === 'critical'))

  return {
    modules,
    tasks: scopedTasks,
    overallProgress: averageModuleProgress(modules),
    completedCount: modules.filter(module => module.progress === 100).length,
    highPriorityModules,
    highPriorityProgress: averageModuleProgress(highPriorityModules),
    highPriorityCompletedCount: highPriorityModules.filter(module => module.progress === 100).length,
  }
}

function normalizeModuleName(value: string) {
  return normalizeDisplayName(value).toLocaleLowerCase('zh-CN')
}

function normalizeDisplayName(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ')
}

function averageProgress(tasks: ProgressTask[]) {
  if (!tasks.length) return 0
  return Math.round(tasks.reduce((sum, task) => sum + clampProgress(task.progress), 0) / tasks.length)
}

function averageModuleProgress(modules: ModuleProgress[]) {
  if (!modules.length) return 0
  return Math.round(modules.reduce((sum, module) => sum + module.progress, 0) / modules.length)
}

function clampProgress(value: number) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0
}

function isCompleted(task: ProgressTask) {
  return task.status === 'completed' || task.status === 'closed' || clampProgress(task.progress) === 100
}
