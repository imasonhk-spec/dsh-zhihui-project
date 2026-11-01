# AI案卷评查项目实施计划表导入字段映射

## 导入原则

系统按所选导入类型自动定位 Excel 页签，不要求用户先拆分工作簿：

- 任务：`详细实施计划（WBS分解）`
- 风险：`风险与问题清单`
- 里程碑：`里程碑及关键节点计划总览`
- 协调事项：`需协调升级事项`

预览阶段会跳过标题、说明、分组和空白行，将中文表头转换为系统字段，并先进行日期、进度、状态和枚举校验。只有预览无错误才允许执行导入。

## 任务/WBS

| Excel 字段 | 系统字段 | 转换与展示 |
|---|---|---|
| WBS编号 | `tasks.wbsCode` | 作为项目内唯一 WBS 编码，在任务树和甘特图展示 |
| 任务名称 | `tasks.name` | 任务主标题 |
| 一级模块 | `project_phases.name` / `tasks.phaseId` | 按名称匹配现有阶段；不存在时导入执行阶段自动创建 `IMP-*` 阶段 |
| 二级模块 | `tasks.description` | 以“二级模块：…”写入补充说明，避免丢失模板层级 |
| 承建方 | `tasks.vendor` | 任务筛选与列表“承建方”列 |
| 责任人 | `tasks.ownerName` | 任务负责人 |
| 开始时间 | `tasks.plannedStartDate` | 统一为 `YYYY-MM-DD` |
| 计划完成时间 | `tasks.plannedEndDate` | 统一为 `YYYY-MM-DD`；如模板出现 `2026-06-31`，规范为当月最后一天 `2026-06-30` |
| 完成进度 | `tasks.progress` | `0.2`、`1` 等比例值转成 `20`、`100`；百分号值直接转百分数 |
| 当前状态 | `tasks.status` | 未启动→`not_started`，进行中→`in_progress`，已完成→`completed`，延期→`delayed` |
| 交付物/范围说明 | `tasks.deliverable` | 任务详情与列表摘要 |
| 延期原因及措施 | `tasks.description` | 非“无”内容追加到说明中 |

模板没有优先级字段，默认使用系统的 `medium`；父任务和依赖关系也不能从当前模板可靠推断，因此不自动生成。

## 风险与问题

| Excel 字段 | 系统字段 | 转换与展示 |
|---|---|---|
| 序号 | `risks.code` | 自动生成 `R-001` 等项目内编码 |
| 风险等级 | `risks.level` | 低/中/高/严重→`low/medium/high/critical` |
| 风险/问题描述 | `risks.name`、`risks.description` | 作为风险标题和描述 |
| 风险来源 | `risks.source` | 风险来源标签 |
| 影响程度、发生概率 | `risks.impact` | 合并为“影响程度：…；发生概率：…” |
| 应对措施 | `risks.mitigation` | 风险卡片应对措施 |
| 责任人 | `risks.ownerName` | 负责人 |
| 预计解决日期 | `risks.expectedResolutionDate` | 统一日期格式；空值保留为空 |
| 状态 | `risks.status` | 待处理→`identified`，处理中→`following`，已缓解→`mitigated`，已关闭→`closed` |

## 里程碑

| Excel 字段 | 系统字段 | 转换与展示 |
|---|---|---|
| 里程碑节点★ | `milestones.name` | 里程碑名称 |
| 开始时间 | `milestones.description` | 当前模型无开始日期字段，保留为“计划开始：YYYY-MM-DD” |
| 计划完成时间★ | `milestones.plannedDate` | 计划日期和预警计算依据 |
| 当前状态 | `milestones.status` | 中文状态转系统枚举 |
| 完成时间 | `milestones.actualDate` | 实际完成日期 |
| 责任方 | `milestones.ownerName` | 责任方 |
| 交付内容 | `milestones.deliverable` | 交付物 |
| ★标记 | `milestones.type` | 本页导入统一设为关键 `key` |

## 协调事项

| Excel 字段 | 系统字段 | 转换与展示 |
|---|---|---|
| 序号 | `coordination_items.code` | 生成 `C-001` 等项目内编码，重复导入按编码更新 |
| 事项描述 | `coordination_items.title` | 协调事项标题 |
| 影响 | `coordination_items.description` | 影响说明 |
| 需支持/决策内容 | `coordination_items.description` | 追加“需支持/决策：…”保留原始语义 |
| 期望解决时间 | `coordination_items.dueDate` | 统一为 `YYYY-MM-DD`，用于逾期预警 |
| 状态 | `coordination_items.status` | 待处理/未开始→`to_start`，处理中→`communicating`，已解决/已完成→`resolved`，已关闭→`closed` |
| 事项类别 | `coordination_items.category` | 模板未提供时默认“项目协调” |
| 优先级 | `coordination_items.priority` | 模板未提供时默认 `medium` |
| 完成进度 | `coordination_items.progress` | 终态固定 100%，非终态按模板值，缺省 0% |

## 尚未直接执行导入的页签

- `项目总览`：包含项目目标、建设工期、投资匡算、承建模式和项目经理。现有项目模型只有部分对应字段，直接覆盖项目主数据风险较高；建议后续做“项目基础信息预览并选择性更新”。
- `立项报批推进计划`：可对应 `approval_items`，但模板中的合并单元格阶段名称需要向下填充，且需确认阶段编码生成规则。
- `下周工作计划`：可作为任务或周报计划，当前两种语义不同，不应静默混入正式 WBS。

以上页签当前保留在原文件中，不会误导入其他模块。