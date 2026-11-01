import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type AssistantSkillSummary = { id: string; name: string; description: string; emoji: string | null; userInvocable: boolean }
export type AssistantSkill = AssistantSkillSummary & { body: string; file: string; updatedAt: string }
export type AssistantSkillPromptSection = { id: string; name: string; section: string }

const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const FALLBACK_SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../skills')

export function resolveSkillsDir() {
  const configured = process.env.SHARED_SKILLS_DIR?.trim()
  return configured ? path.resolve(configured) : FALLBACK_SKILLS_DIR
}

export async function listAssistantSkills(): Promise<AssistantSkillSummary[]> {
  const dir = resolveSkillsDir()
  let entries: string[]
  try { entries = await readdir(dir) } catch { return [] }
  const items: AssistantSkillSummary[] = []
  for (const entry of entries.sort()) {
    if (!SKILL_ID_PATTERN.test(entry)) continue
    try {
      const skill = await getAssistantSkill(entry)
      items.push({ id: skill.id, name: skill.name, description: skill.description, emoji: skill.emoji, userInvocable: skill.userInvocable })
    } catch { /* 目录缺少合法 SKILL.md 时跳过 */ }
  }
  return items
}

export async function getAssistantSkill(id: string): Promise<AssistantSkill> {
  if (!SKILL_ID_PATTERN.test(id)) throw new Error('ai_skill_id_invalid')
  const dir = resolveSkillsDir()
  const file = path.resolve(dir, id, 'SKILL.md')
  if (!file.startsWith(dir + path.sep)) throw new Error('ai_skill_id_invalid')
  let raw: string
  try { raw = await readFile(file, 'utf8') } catch { throw new Error('ai_skill_not_found') }
  const info = await stat(file)
  const { meta, body } = parseSkillMarkdown(raw)
  const name = meta.get('name') ?? id
  const description = meta.get('description') ?? ''
  const userInvocable = meta.get('user-invocable') === 'true'
  const emojiMatch = raw.match(/^\s*emoji:\s*"?([^"\n]+)"?\s*$/m)
  return { id, name, description, emoji: emojiMatch?.[1]?.trim() ?? null, userInvocable, body, file, updatedAt: info.mtime.toISOString() }
}

/** 将技能适配到项目智能助手环境：技能原文保持只读，环境差异在适配说明中声明。 */
export function renderSkillPromptSection(skill: AssistantSkill): AssistantSkillPromptSection {
  const section = `技能适配说明（本助手环境与技能原文的差异按以下约定执行）：
1. 材料范围：本会话的"材料"仅指下方提供的"当前项目业务数据库事实"与"当前版本知识文档证据"（会议纪要、实施计划、商机表、阶段汇报、周报等均以这两类证据形式提供）；不得访问文件系统、扫描目录或读写任何文件，也不得访问其他项目。
2. 输出范围：当前会话固定为 scope=project（单一项目工作区），按技能中 project 规则输出；用户要求 portfolio/selection 等跨项目范围时，说明本会话仅覆盖当前项目，不跨项目合并或推断。
3. 证据位置：技能要求的"文件名｜页码/段落标题/Sheet/原始行号"在本环境中改写为证据标注——知识文档使用【文档:N】（可附页码/章节），业务事实使用【业务:类型:ID】；无法定位证据的内容标注"待核实"。
4. 材料只读：不得声称移动、重命名、修改或归档任何原始材料；分类与索引结果只体现在回答正文中。
5. 其余规则（材料归集口径、项目主键优先级、事实与证据、来源分层、四问、Grounded Copy 表达、领导汇报结构、质量门禁）按技能原文执行；输出前按质量门禁逐项自查，冲突时以本助手的安全与证据规则为准。

以下为技能原文：

${skill.body}`
  return { id: skill.id, name: skill.name, section }
}

export function parseSkillMarkdown(raw: string) {
  const meta = new Map<string, string>()
  let body = raw
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const pair = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line)
      if (pair) meta.set(pair[1].toLowerCase(), pair[2].replace(/^"|"$/g, '').trim())
    }
    body = raw.slice(match[0].length)
  }
  return { meta, body: body.trim() }
}
