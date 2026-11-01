import { test, expect } from '@playwright/test'

// No login, seeded identity, or AI calls are needed: API responses are read-only.
const projectId = process.env.DSH_SMOKE_PROJECT_ID ?? 'smoke-project'
const projectPath = (suffix: string) => `/projects/${projectId}${suffix}`

test.describe('核心页面冒烟', () => {
  test('Web 入口与 API 健康检查可用', async ({ page, request }) => {
    const health = await request.get('/health')
    expect(health.ok()).toBeTruthy()
    expect(await health.json()).toMatchObject({ ok: true })

    await page.goto('/')
    await expect(page).toHaveTitle(/项目|Project|交付中心/i)
    await expect(page.getByText('项目总览', { exact: true })).toBeVisible()
  })

  test('项目路由与导入页面可见', async ({ page }) => {
    await page.goto(projectPath('/imports'))
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/imports$`))
    await expect(page.getByRole('heading', { name: '项目导入任务' })).toBeVisible()
    await expect(page.getByText('文件导入', { exact: true })).toBeVisible()
    await expect(page.getByText('请选择 CSV、XLSX 或 XLSM 文件。', { exact: true })).toBeVisible()
  })

  test('通知页面可见并提供筛选控件', async ({ page }) => {
    await page.goto(projectPath('/notifications'))
    await expect(page.getByRole('heading', { name: '站内通知' })).toBeVisible()
    await expect(page.getByRole('combobox', { name: '通知筛选' })).toBeVisible()
    await expect(page.getByText('最近活动', { exact: true })).toBeVisible()
  })

  test('阶段导航页面可见', async ({ page }) => {
    await page.goto(projectPath('/phases'))
    await expect(page.getByRole('heading', { name: '阶段维护' })).toBeVisible()
    await expect(page.getByText('阶段列表', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '新增阶段' })).toBeVisible()
  })
})
