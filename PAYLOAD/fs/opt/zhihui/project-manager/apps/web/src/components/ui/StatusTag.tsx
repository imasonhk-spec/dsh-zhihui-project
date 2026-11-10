import { Tag } from '@arco-design/web-react'
import { statusLabelMap, statusToneMap, type StatusTone } from '../../theme/status.ts'

export type StatusTagProps = {
  value: string
  label?: string
  tone?: StatusTone
}

const colorMap: Record<StatusTone, string | undefined> = {
  default: undefined,
  primary: 'arcoblue',
  success: 'green',
  warning: 'orange',
  danger: 'red',
  purple: 'purple',
}

export function StatusTag({ value, label, tone }: StatusTagProps) {
  const resolvedTone = tone ?? statusToneMap[value] ?? 'default'
  return <Tag color={colorMap[resolvedTone]}>{label ?? statusLabelMap[value] ?? value}</Tag>
}
