import { Button, Empty, Result, Skeleton, Typography } from '@arco-design/web-react'

export type LoadingStateProps = {
  title?: string
  description?: string
}

export function LoadingState({ title = '正在加载', description = '请稍候，正在获取最新数据。' }: LoadingStateProps) {
  return (
    <section className="page-state" aria-live="polite" aria-busy="true">
      <Typography.Title heading={6}>{title}</Typography.Title>
      <Typography.Text type="secondary">{description}</Typography.Text>
      <Skeleton animation text={{ rows: 8, width: ['38%', '100%', '92%', '96%', '84%', '100%', '88%', '72%'] }} />
    </section>
  )
}

export type EmptyStateProps = {
  title?: string
  description?: string
  actionLabel?: string
  onAction?: () => void
}

export function EmptyState({ title = '暂无数据', description = '当前条件下没有可展示的内容。', actionLabel, onAction }: EmptyStateProps) {
  return (
    <section className="page-state">
      <Empty description={title} />
      <Typography.Text type="secondary">{description}</Typography.Text>
      {actionLabel && onAction ? <Button type="primary" onClick={onAction}>{actionLabel}</Button> : null}
    </section>
  )
}

export type ErrorStateProps = {
  title?: string
  description?: string
  retryLabel?: string
  onRetry?: () => void
}

export function ErrorState({ title = '页面加载失败', description = '服务暂时不可用，请稍后重试。', retryLabel = '重新加载', onRetry }: ErrorStateProps) {
  return (
    <section className="page-state">
      <Result status="error" title={title} subTitle={description} />
      {onRetry ? <Button type="primary" onClick={onRetry}>{retryLabel}</Button> : null}
    </section>
  )
}
