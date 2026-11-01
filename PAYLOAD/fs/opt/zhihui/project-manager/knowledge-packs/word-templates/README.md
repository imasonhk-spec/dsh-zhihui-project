# 统一 Word 生成模板注册表

- 模板规范 ID：`PM-DOCX-UNIFIED`
- 规范版本：`1.0.0`
- 实现注册表：`apps/api/src/modules/ai/document-template-registry.ts`
- 生成实现：`apps/api/src/modules/ai/project-document-service.ts`
- 输出格式：仅 `.docx`
- MIME：`application/vnd.openxmlformats-officedocument.wordprocessingml.document`

本目录只保存可审计的模板说明与版本，不提交二进制 Word 模板。服务端使用 `docx` 依赖按注册表程序化生成文档。

## 统一版式

1. A4 纵向，四边页边距 25.4 mm。
2. 文档标题居中、黑体；一级/二级标题使用黑体。
3. 正文使用仿宋，首行缩进，固定中文公文风格行距。
4. 页眉显示项目名称和文档标题；页脚显示页码。
5. 首页明确显示模板标识、生成日期和数据范围。
6. 正文之后固定附“证据与待补信息”，结构化事实引用格式为 `[业务数据库:类型:ID]`，知识库事实引用格式为 `[知识库:document:ID]`。
7. 不使用模板示例补齐项目事实；缺失数据明确写为“待补”。客户拜访纪要没有会议/拜访证据时不得生成虚构会议内容。
8. 生成文档归档到 `01-项目管理过程/03-周报与汇报`，随后以下载流返回。

## 模板清单

| docType | 模板 ID | 版本 | 标题 |
| --- | --- | --- | --- |
| `project_weekly_report` | `PM-DOC-PWR` | `1.0.0` | 项目周报 |
| `risk_coordination_summary` | `PM-DOC-RCS` | `1.0.0` | 风险与协调事项汇总 |
| `milestone_warning` | `PM-DOC-MW` | `1.0.0` | 里程碑预警 |
| `stage_progress` | `PM-DOC-SP` | `1.0.0` | 阶段进展报告 |
| `opportunity_weekly_report` | `PM-DOC-OWR` | `1.0.0` | 商机周报 |
| `customer_visit_minutes` | `PM-DOC-CVM` | `1.0.0` | 客户拜访纪要 |
| `requirement_analysis` | `PM-DOC-RA` | `1.0.0` | 需求分析 |
| `opportunity_handover` | `PM-DOC-OH` | `1.0.0` | 商机移交单 |

## 数据边界

普通项目只读取当前项目的结构化事实与当前有效知识库文档。`OPP-MASTER` 生成商机类材料时，结构化项目概况仍来自 `buildProjectContext`，知识库事实允许读取全部项目当前有效、已解析的知识文档。所有知识事实都保留来源文档 ID，不将商机计划、预测或模板示例表述为已交付事实。
