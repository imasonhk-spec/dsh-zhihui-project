import { Typography } from '@arco-design/web-react'

export type PlaceholderPageProps = {
  eyebrow: string
  title: string
  description: string
}

export function PlaceholderPage({ eyebrow, title, description }: PlaceholderPageProps) {
  return (
    <main className="placeholder-page">
      <Typography.Text className="placeholder-page__eyebrow">{eyebrow}</Typography.Text>
      <Typography.Title heading={2}>{title}</Typography.Title>
      <Typography.Paragraph>{description}</Typography.Paragraph>
    </main>
  )
}
