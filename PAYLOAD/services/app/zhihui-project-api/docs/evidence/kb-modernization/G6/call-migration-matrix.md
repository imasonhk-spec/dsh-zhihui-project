# P0-05 两端调用迁移与负向验证清单

> 范围仅含智汇·项目、智汇·商机及 OPP-MASTER；微信机器人链路禁止修改。状态基于首轮集成源码与自动测试。

|应用|层级|调用锚点|目标作用域/约束|负向证据|状态|
|---|---|---|---|---|---|
|智汇·项目|Web|`apps/web/src/pages/projects/ProjectAiAssistantPage.tsx`|读取 overview 后仅 OPP-MASTER 请求 `all-projects`；普通项目无该 scope|普通项目预取 `apps/web/src/api/projects.ts#prefetchProjectModules` 已调用默认项目 scope|完成|
|智汇·项目|API|`apps/api/src/server.ts` 的 knowledge workspace/hybrid/RAG 路由|`all-projects` 由 OPP-MASTER 服务端授权；客户端不能传项目集合|`knowledge-authorization.test.ts` 覆盖普通项目、未知项目、空授权|完成|
|智汇·项目|服务|`knowledge-authorization.ts` / `hybrid-search-service.ts`|服务层二次鉴权；SQL 候选同层限定 authorized IDs/project scope/account null/non-null project|`knowledge-authorization.test.ts`、`hybrid-search-scope.test.ts`|完成|
|智汇·项目|RAG|`rag-answer-service.ts` / `rag-prompt.ts`|普通项目与 OPP-MASTER 提示分离；来源逐条保留；无证据拒答|`occamy-rag.test.ts`、`evidence-envelope.test.ts`|完成|
|智汇·商机|Web|`../bussiness-manager/apps/web/src/api/projects.ts#getKnowledgeWorkspace`|固定共享项目页面使用 `portfolio:OPP-MASTER`；不得用于任意普通项目|源码清单复核；由项目 API 的 OPP-MASTER 鉴权兜底|完成待独立评审|
|智汇·商机|API|`../bussiness-manager/apps/api/src/server.ts` `/api/knowledge/search`|只允许 OPP-MASTER 映射；禁止客户端 `projectId` 扩域|`opportunity-knowledge-scope.test.ts`|完成|
|智汇·商机|模型输出|`../bussiness-manager/apps/api/src/harness-client.ts`|Occamy 输出清理 reasoning/control/system 泄露|`harness-client.test.ts`|完成|

## 已自动执行的安全负例

- 伪造 `scope=all-projects` / 普通项目直接请求。
- 绕过路由直接构造组合授权。
- 空授权、未知项目、授权集合重复/非法 ID。
- personal/account scope、`project_id IS NULL`、知识库与文档项目不一致的 SQL 谓词快照。
- OPP-MASTER 提示扩域、用户项目 ID 诱导、system/reasoning/control token 泄露。
- EvidenceEnvelope 来源项目/版本/分块/checksum 保留与引用去重回放。
- 智汇·商机非 OPP-MASTER workspace 与客户端 `projectId` 拒绝。

清单无“未知调用点”。该清单不代表真实生产流量或灰度执行。
