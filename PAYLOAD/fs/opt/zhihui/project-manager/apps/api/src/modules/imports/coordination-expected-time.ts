export type CoordinationTimeStatus = 'to_start' | 'communicating' | 'resolved' | 'closed'

export type CoordinationExpectedTime = {
  raw: string
  status?: CoordinationTimeStatus
  dueDate?: string
  resolvedAt?: string
  progress?: number
  kind: 'empty' | 'deadline' | 'resolved' | 'communicating' | 'pending' | 'unknown'
}

/** Parse the free-form “期望解决时间” cell without discarding its original wording. */
export function parseCoordinationExpectedTime(value: string | undefined, referenceDate = new Date()): CoordinationExpectedTime {
  const raw = normalizeRawText(value)
  const normalized = raw.normalize('NFKC')
  if (!normalized || isEmptyMarker(normalized)) return { raw, kind: 'empty' }

  const date = extractDate(normalized, referenceDate)
  if (isClosedText(normalized)) return { raw, kind: 'resolved', status: 'closed', progress: 100, resolvedAt: date }
  if (isResolvedText(normalized)) return { raw, kind: 'resolved', status: 'resolved', progress: 100, resolvedAt: date }
  if (isCommunicatingText(normalized)) return { raw, kind: 'communicating', status: 'communicating', dueDate: date }
  if (isPendingText(normalized)) return { raw, kind: 'pending', status: 'to_start', dueDate: date }
  if (date) return { raw, kind: 'deadline', dueDate: date }
  return { raw, kind: 'unknown' }
}

function extractDate(value: string, referenceDate: Date) {
  const full = /(20\d{2})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*日?/.exec(value)
  if (full) return validDate(Number(full[1]), Number(full[2]), Number(full[3]))

  const compact = /(?:^|\D)(20\d{2})(\d{2})(\d{2})(?:\D|$)/.exec(value)
  if (compact) return validDate(Number(compact[1]), Number(compact[2]), Number(compact[3]))

  const isoTime = /(20\d{2})-(\d{2})-(\d{2})T\d{2}:\d{2}/.exec(value)
  if (isoTime) return validDate(Number(isoTime[1]), Number(isoTime[2]), Number(isoTime[3]))

  const english = /^(?:[A-Z][a-z]{2}\s+)?([A-Z][a-z]{2})\s+(\d{1,2})(?:\s+(20\d{2}))?(?:\s|$)/.exec(value)
  if (english) {
    const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(english[1]) + 1
    return validDate(Number(english[3] || referenceDate.getUTCFullYear()), month, Number(english[2]))
  }

  const partial = /(?:^|[^\d])(\d{1,2})\s*[月/\-.]\s*(\d{1,2})\s*日?/.exec(value)
  if (partial) return validDate(referenceDate.getUTCFullYear(), Number(partial[1]), Number(partial[2]))

  if (/下月(?:底|内|末)/.test(value)) {
    const month = referenceDate.getUTCMonth() + 2
    const year = referenceDate.getUTCFullYear() + (month > 12 ? 1 : 0)
    return lastDayOfMonth(year, month > 12 ? month - 12 : month)
  }
  if (/本月(?:底|内|末)|(?<!下)月底/.test(value)) return lastDayOfMonth(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth() + 1)

  const yearMonth = /(?:^|\D)(20\d{2})\s*(?:年|[\-/.])\s*(\d{1,2})\s*月?(?:内|底|末|月底|前)?(?:$|\D)/.exec(value)
  if (yearMonth) return lastDayOfMonth(Number(yearMonth[1]), Number(yearMonth[2]))
  const monthEnd = /(?:^|\D)(\d{1,2})\s*月\s*(?:内|底|末|月底|前)(?:$|\D)/.exec(value)
  if (monthEnd) return lastDayOfMonth(referenceDate.getUTCFullYear(), Number(monthEnd[1]))

  const quarter = /(?:(20\d{2})\s*年?\s*)?(?:第\s*([一二三四1-4])\s*季度|Q([1-4]))(?:末|内|前)?/i.exec(value)
  if (quarter) {
    const year = Number(quarter[1] || referenceDate.getUTCFullYear())
    const token = quarter[2] || quarter[3]
    const q = ({ 一: 1, 二: 2, 三: 3, 四: 4 } as Record<string, number>)[token] || Number(token)
    return lastDayOfMonth(year, q * 3)
  }
  return undefined
}

function lastDayOfMonth(year: number, month: number) {
  if (month < 1 || month > 12) return undefined
  return validDate(year, month, new Date(Date.UTC(year, month, 0)).getUTCDate())
}

function validDate(year: number, month: number, day: number) {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1) return undefined
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return undefined
  return date.toISOString().slice(0, 10)
}

function isResolvedText(value: string) {
  return /已解决|已完成|(?<!未)完成(?:$|[（(\s])|处理完毕|协调完成|问题解决|达成/.test(value)
}

function isClosedText(value: string) {
  return /已关闭|已结项|关闭完成/.test(value)
}

function isCommunicatingText(value: string) {
  return /推进中|进行中|沟通中|协调中|处理中|跟进中|持续(?:推进|跟进)|长期跟进|长期推进|持续观察/.test(value)
}

function isPendingText(value: string) {
  return /待评估|待确认|待定|待明确|未明确|暂未明确|待协调|待推进|待启动|未开始|尚未开始/.test(value)
}

function isEmptyMarker(value: string) {
  return ['/', '-', '—', '无', '暂无', '不涉及', 'n/a', 'na'].includes(value.toLowerCase())
}

function normalizeRawText(value: string | undefined) {
  return String(value ?? '').trim().replace(/\s+/g, ' ')
}
