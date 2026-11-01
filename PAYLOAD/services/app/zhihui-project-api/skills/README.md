# skills/ — 跨应用共享技能目录

本目录是项目智能助手技能的**共享目录（canonical store）**。每个技能一个子目录，目录名即技能 id（kebab-case），内含一份 `SKILL.md`（frontmatter + 正文）。

## 调用链接入方式

技能不是静态文档拷贝，而是接入 AI 会话实际调用链：

1. `apps/api/src/modules/ai/skill-service.ts` 从本目录加载并解析技能（id 白名单校验，防路径穿越）；
2. `GET /api/ai/skills`、`GET /api/ai/skills/:skillId` 对外暴露技能清单与正文；
3. `POST /api/projects/:projectId/ai/conversations/:conversationId/messages` 接受可选 `skill` 字段；命中后 `rag-prompt.ts` 将技能说明（含本助手环境的适配规则）注入发给 DeepSeek Harness 的会话提示词，`skill` id 记入消息 metadata，重试（retry）自动沿用。

## 跨应用共享

商机管理中心（`/home/lgsj/harness/bussiness-manager`）不复制技能文件，其智能助手经既有 `/shared-api` 适配层（vite 代理 → 本应用 `/api`）消费同一份技能与同一条 AI 会话链路。

## 配置

- 环境变量 `SHARED_SKILLS_DIR` 可将技能目录指向仓库外路径（缺省为本目录）。
- 新增技能：建立 `<skill-id>/SKILL.md`，frontmatter 至少含 `name`、`description`；无需改代码，服务端按目录动态发现。
