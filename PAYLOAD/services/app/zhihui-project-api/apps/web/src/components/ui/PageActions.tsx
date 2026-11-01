import { Space } from '@arco-design/web-react'
import type { PropsWithChildren } from 'react'

export type PageActionsProps = PropsWithChildren<{
  align?: 'start' | 'end'
}>

export function PageActions({ align = 'end', children }: PageActionsProps) {
  return (
    <div className={`page-actions page-actions--${align}`}>
      <Space wrap>{children}</Space>
    </div>
  )
}
