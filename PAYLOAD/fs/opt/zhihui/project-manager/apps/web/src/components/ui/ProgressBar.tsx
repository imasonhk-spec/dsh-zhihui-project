import { Progress, Typography } from '@arco-design/web-react'

export type ProgressBarProps = {
  value: number
  label?: string
  showText?: boolean
  status?: 'normal' | 'success' | 'error' | 'warning'
}

export function ProgressBar({ value, label, showText = true, status = 'normal' }: ProgressBarProps) {
  const safeValue = Math.min(100, Math.max(0, value))
  return (
    <div className="progress-bar">
      {label ? <Typography.Text>{label}</Typography.Text> : null}
      <Progress percent={safeValue} showText={showText} status={status} size="small" />
    </div>
  )
}
