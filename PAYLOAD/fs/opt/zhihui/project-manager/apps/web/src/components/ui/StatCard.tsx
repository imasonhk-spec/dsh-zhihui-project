import { Card, Statistic, Typography } from '@arco-design/web-react'
import type { ReactNode } from 'react'

export type StatCardProps = {
  title: string
  value: number | string
  suffix?: string
  icon?: ReactNode
  description?: string
  tone?: 'blue' | 'green' | 'orange' | 'red' | 'purple'
}

export function StatCard({ title, value, suffix, icon, description, tone = 'blue' }: StatCardProps) {
  return (
    <Card className={`stat-card stat-card--${tone}`} bordered>
      <div className="stat-card__top">
        <Statistic title={title} value={value} suffix={suffix} />
        {icon ? <span className="stat-card__icon">{icon}</span> : null}
      </div>
      {description ? <Typography.Text type="secondary">{description}</Typography.Text> : null}
    </Card>
  )
}
