import { Card, Typography } from '@arco-design/web-react'
import type { PropsWithChildren, ReactNode } from 'react'

export type DataPanelProps = PropsWithChildren<{
  title: string
  description?: string
  extra?: ReactNode
  noPadding?: boolean
}>

export function DataPanel({ title, description, extra, noPadding = false, children }: DataPanelProps) {
  return (
    <Card
      className={`data-panel${noPadding ? ' data-panel--no-padding' : ''}`}
      title={(
        <div className="data-panel__heading">
          <Typography.Text bold>{title}</Typography.Text>
          {description ? <Typography.Text type="secondary">{description}</Typography.Text> : null}
        </div>
      )}
      extra={extra}
      bordered
    >
      {children}
    </Card>
  )
}
