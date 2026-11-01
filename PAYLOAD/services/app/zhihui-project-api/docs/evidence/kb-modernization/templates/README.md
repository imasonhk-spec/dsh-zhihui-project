# 中文项目管理模板包实施证据

本目录记录 `knowledge-packs/` 首版候选包的非生产证据。

## 覆盖矩阵

|方案能力|模板 ID|关键约束|
|---|---|---|
|进度|project_progress|当前事实、在途、里程碑、偏差|
|难点|issue_difficulty|现象与根因假设分离、闭环标准|
|风险|risk_register|概率/影响/触发条件/应对|
|未来预期|forecast_outlook|依据、假设、置信度、asOf|
|协调|coordination_escalation|已采取措施、选项、决策人与期限|
|周报|weekly_report|本周事实与下周承诺分区|
|月报|monthly_report|同口径趋势与下月预测|
|验收结项|acceptance_closure|范围、依据、环境、用例、整改、结论、签署、移交|
|商机|opportunity_review|阶段/金额事实与签约概率预测分离|
|跨项目汇报|portfolio_briefing|服务端授权集合、逐项目来源、交付/商机分区|

## 文件与用途

- `knowledge-packs/manifest.json`：包版本、模型生成约束、制品入口与发布禁令。
- `knowledge-packs/schemas/document-instance.schema.json`：适合 32K 模型上下文注入的单一紧凑实例 Schema。
- `knowledge-packs/templates/catalog.json`：十类文书最小字段提示和证据规则。
- `knowledge-packs/field-dictionary.md`：事实语义、缺失、冲突与引用字典。
- `knowledge-packs/examples/examples.json`：正例及越权、缺证、预测混写、未签署、未许可等边界例。
- `license-register.json`：逐制品许可核验账；未核验外部项均为 blocked。

## 安全与发布结论

1. 本包内容为中国政企场景原创结构，不含外部模板正文，不宣称 Open PM² 官方中文版。
2. Open PM² 候选制品未逐件获得权威来源与许可证据，全部 `blocked`、`publishable=false`、`indexable=false`。
3. `manifest` 为 `candidate`，全包 `publishable=false/indexable=false`；本次没有导入生产知识库或向量库。
4. 未访问或修改微信机器人知识库、个人记忆、周期报告、索引、路由和服务配置。
5. 输出仅为草稿；法律、行政审批、合同与验收结论必须人工复核、审批和签署。
