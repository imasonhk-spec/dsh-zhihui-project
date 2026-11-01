import type { PropsWithChildren, ReactNode } from 'react'

export type PageContainerProps = PropsWithChildren<{
  title?: string
  description?: string
  actions?: ReactNode
}>

export function PageContainer({ title, description, actions, children }: PageContainerProps) {
  return (
    <section className="page-container">
      {title || description || actions ? (
        <header className="page-container__header">
          <div>
            {title ? <h1>{title}</h1> : null}
            {description ? <p>{description}</p> : null}
          </div>
          {actions ? <div className="page-container__actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className="page-container__body">{children}</div>
    </section>
  )
}
