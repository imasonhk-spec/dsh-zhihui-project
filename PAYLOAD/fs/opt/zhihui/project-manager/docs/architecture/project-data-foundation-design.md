# 项目实施计划表适配与数据底座设计

## 1. 结论与设计原则

本次抽样覆盖 10 个项目、每个工作簿约 6–7 个页签，核心结构高度一致：项目总览、立项报批、里程碑、WBS、风险/问题、周计划、协调升级事项。现有系统已经具备 `projects / project_phases / tasks / milestones / risks / coordination_items / approval_items / knowledge_bases / documents / document_versions / document_chunks` 主链路，可采取“增量扩展而非推倒重建”。

底层必须遵循：

1. **项目是一级租户边界**：所有业务数据、文档、知识库、AI 会话、检索结果必须显式或可验证地归属 `project_id`。
2. **结构化事实与原始材料双轨保存**：Excel 映射为任务、里程碑、风险等结构化记录；原始 Excel、合同、会议纪要、招投标文件等作为不可变文档版本保存。
3. **关系字段规范化，展示字段保留快照**：负责人、组织、供应商以后用关系表；历史表中的 `owner_name/vendor` 可暂留作导入快照，避免第一次迁移丢信息。
4. **版本、来源、血缘可追溯**：每条导入记录保留 `import_job_id / source_document_id / source_sheet / source_row / source_payload / source_hash`。
5. **知识检索强制先按项目过滤，再做全文/向量排序**，防止跨项目材料串库。
6. **JSONB 只承接长尾差异，不代替核心列**；需要过滤、统计、排序、关联的字段必须建成普通列。

## 2. Excel 结构分析

### 2.1 共同页签和核心字段

| 页签 | 常见字段 | 目标模块/表 |
|---|---|---|
| 项目总览 | 项目名称、建设目标、周期、项目阶段、合同金额、关键目标、承建/合作单位、咨询单位、项目经理、填报日期 | `projects` + `project_stakeholders` + `project_members` |
| 立项报批推进计划 | 阶段/事项、任务内容、状态、计划开始/完成、责任方、交付物 | `approval_items`；必要时关联 `project_phases` |
| 里程碑及关键节点 | 节点、开始时间、计划完成时间、状态、完成时间、责任方、交付物 | `milestones` |
| 详细实施计划（WBS） | WBS、一级模块、二级模块、任务名称、承建方、责任人、开始/完成、优先级、进度、状态、交付物、延期原因及措施 | `project_phases` + `work_packages` + `tasks` + `task_assignments` |
| 风险与问题清单 | 风险/问题描述、来源、影响程度、发生概率、应对措施、责任人、预计解决日期、状态、说明 | `risks`（建议区分 `item_type=risk/issue`） |
| 下周工作计划 | 周期、本周总结、计划任务、承建方、责任人、开始/完成、交付物、依赖条件 | `weekly_reports` + `weekly_plan_items`，并可关联 `tasks` |
| 需协调升级事项 | 事项描述、影响、支持/决策内容、期望解决时间 | `coordination_items` |

### 2.2 已识别的表格差异

- WBS 表头存在“一级模块/二级模块”，也存在前三列为合并单元格或富文本对象的情况，不能依赖固定列标题一次解析。
- 优先级同时出现 `P0`、`高/中/低`、空值；需要统一映射到 `critical/high/medium/low`，同时保留 `source_priority`。
- 状态出现 `待开始/未开始/进行中/已完成/已延期/已延期（阻塞）/跟进中/已解决/已关闭` 等，必须按实体类型做映射，不能全局用一个枚举直接硬套。
- 进度多以 Excel 小数（如 `1` 表示 100%）表达，也可能为百分数字符串；导入时统一为 `0–100` 数值。
- 负责人/责任方常为多人字符串，并混有组织名与人员名；首轮导入保留原文，同时拆解到成员/组织关系表，由人工确认歧义。
- 里程碑“完成时间”可能填入“未完成/已完成”等非日期文本，需要解析结果列与实际日期列分离。
- 风险概率既有小数（0.8）也有 `高/中/低`，应同时支持 `probability_percent` 与 `probability_level`。
- 部分工作簿包含实际业务材料内容，部分仍保留模板标题“某项目名称”，项目名应优先取文件名与项目总览值交叉校验。

### 2.3 标准字段映射

| Excel 字段 | 标准字段 | 规则 |
|---|---|---|
| 一级模块 | `work_packages.level=1, name` | 同项目同父级下名称归一去重 |
| 二级模块 | `work_packages.level=2, parent_id` | 父级绑定一级模块 |
| 序号/WBS | `tasks.wbs_code` | 字符串保存，禁止转浮点导致 `1.10→1.1` |
| 任务名称/计划任务 | `tasks.name` | 去首尾空格，保留内部换行语义 |
| 承建方 | `task_parties.organization_id` + `tasks.vendor` | 关系为主、原文快照为辅 |
| 责任人 | `task_assignments.member_id` + `tasks.owner_name` | 多值拆分，原文不丢失 |
| 开始时间 | `planned_start_date` | 无时区业务日期，使用 `date` |
| 计划完成时间 | `planned_end_date` | 无时区业务日期 |
| 当前状态 | 实体对应 status | 使用实体级映射表 |
| 完成进度 | `progress` | 推荐 `numeric(5,2)`，范围 0–100 |
| 交付物/范围说明 | `deliverable` + `task_deliverables` | 简述留任务，独立交付件建表 |
| 延期原因及措施 | `delay_reason`, `recovery_action` | 不再混入 metadata |
| 依赖条件 | `task_dependencies` 或 `dependency_note` | 可识别 WBS 时建关系，否则保存文本 |

## 3. 现有模块适配建议

### 3.1 保留并增强

- `projects`：增加项目阶段、合同金额/币种、项目经理成员关系、归档/软删除、导入源。
- `project_phases`：继续作为生命周期阶段；不要把一级/二级功能模块强行塞进 phase。
- `tasks`：保持核心 WBS 表，新增工作包、延期、来源血缘字段。
- `milestones`：补充计划开始时间、关键标识、来源行。
- `risks`：补 `item_type`、概率、影响、问题说明、解决结果；沿用既有 accepted/closed 规则。
- `coordination_items`：补 `impact / support_required / decision_required / source_row`。
- `approval_items`：直接承接立项报批计划，补父子阶段与依赖关系。
- `import_jobs`：从简单计数扩展为可重试、可回滚、幂等导入批次。

### 3.2 新增模块

1. `organizations`、`project_stakeholders`：客户、承建方、供应商、咨询方、监管方。
2. `people`、`project_members`、`task_assignments`：人员主数据及项目/任务角色。
3. `work_packages`：一级/二级模块树，避免与项目生命周期阶段混淆。
4. `task_deliverables`：交付物清单、状态、验收、关联文档。
5. `weekly_reports`、`weekly_plan_items`：保存周报上下文和周期快照，不能只覆盖任务当前值。
6. `import_sources`、`import_row_records`：Excel 工作簿/页签/行的血缘和幂等键。
7. `document_relations`：文档与项目实体、合同、会议、招投标、任务、里程碑、风险的多态关系。
8. `document_acl`：敏感合同/招投标/纪检材料的权限控制。
9. `embedding_models`、`knowledge_index_jobs`：模型版本、维度和重建任务治理。

## 4. 推荐数据库分层

### 4.1 项目主数据域

- `projects`
- `organizations`
- `people`
- `project_stakeholders(project_id, organization_id, role)`
- `project_members(project_id, person_id, role, organization_id, is_primary)`

重要约束：项目编码全局唯一；项目成员在同项目/人员/角色下唯一；项目经理允许多人但需 `is_primary` 标记唯一主负责人。

### 4.2 计划与执行域

- `project_phases`：立项、需求、设计、研发、测试、上线、验收、运维等生命周期。
- `work_packages`：业务模块树，使用 `parent_id/path/depth/sort_order`。
- `tasks`：WBS 任务，带 `phase_id/work_package_id/parent_id`。
- `task_assignments`、`task_parties`、`task_dependencies`、`task_deliverables`。
- `milestones`、`approval_items`、`weekly_reports`、`weekly_plan_items`。

建议将所有百分比由 `real` 改为 `numeric(5,2)`，规避浮点统计误差；加入 CHECK 约束 `0 <= progress <= 100`。

### 4.3 风险与协同域

`risks` 采用风险/问题统一表：

- `item_type`: risk / issue
- `probability_percent`: 0–100
- `probability_level`: low / medium / high
- `impact_level`: low / medium / high / critical
- `risk_score`: 可生成或应用层计算
- `status`、`owner_member_id`、`expected_resolution_date`、`resolved_at`

协调事项记录影响、请求支持、所需决策、期望解决时间、升级级别。所有状态变更进入 `audit_logs`。

### 4.4 导入与数据血缘域

`import_jobs` 建议增加：`source_document_id`、`template_version`、`mapping_version`、`started_at`、`finished_at`、`idempotency_key`、`rollback_status`。

`import_row_records` 保存：

- `project_id/import_job_id`
- `source_sheet/source_row/source_hash`
- `target_entity_type/target_entity_id`
- `raw_payload/normalized_payload`
- `status/error_code/error_message`

唯一键 `(import_job_id, source_sheet, source_row)`；业务幂等另用 `(project_id, target_entity_type, source_hash)` 的条件策略，不盲目覆盖用户已编辑数据。

## 5. 关键索引策略

### 5.1 事务与列表查询

- `projects(status, updated_at desc)`，条件 `status <> 'archived'`。
- `tasks(project_id, status, planned_end_date)`：项目任务列表、逾期筛选。
- `tasks(project_id, phase_id, sort_order)`、`tasks(project_id, work_package_id, sort_order)`。
- `tasks(project_id, parent_id)`：WBS 树。
- `milestones(project_id, status, planned_date)`：未来 7 天临近节点。
- `risks(project_id, status, level, expected_resolution_date)`：活动风险排序。
- `coordination_items(project_id, status, priority, due_date)`。
- `approval_items(project_id, status, planned_end_date)`。
- `documents(project_id, document_type, status, updated_at desc)`。
- `document_relations(project_id, entity_type, entity_id)`。

不要为低选择性单列枚举普遍建索引，应始终把 `project_id` 放在复合索引前部。对 archived/closed 等冷数据使用 partial index。

### 5.2 全文与向量检索

现有 `document_chunks.search_vector GIN` 和 `embedding vector(1024) HNSW cosine` 方向正确，但必须增强：

- `document_chunks` 冗余 `project_id/knowledge_base_id`（由触发器或处理链保证与 document 一致），便于索引前过滤和分区。
- 普通 B-tree：`(project_id, document_id, version_id, chunk_index)`。
- 元数据筛选：`metadata jsonb_path_ops` GIN，仅在确实按标签/文档类型过滤时创建。
- HNSW 不能原生保证项目隔离，查询必须 join/filter project；数据量增大后按 `project_id` 哈希分区，或按项目/知识库拆分外部向量 collection。
- 中文全文检索需引入合适分词（如 PG 分词扩展）或使用 trigram/外部搜索引擎；当前 `to_tsvector('simple', ...)` 对中文召回有限。

## 6. 知识库、对象存储与向量库设计

### 6.1 项目知识空间

每个项目默认一个 `knowledge_base(scope='project')`，并保留一个项目唯一约束。建议标准目录/标签：

- `01_立项报批`
- `02_招投标`
- `03_合同与补充协议`
- `04_需求与设计`
- `05_实施计划与周报`
- `06_会议纪要`
- `07_测试与安全测评`
- `08_上线验收`
- `09_运维与变更`
- `10_风险问题与往来函件`

目录只用于浏览；检索过滤依赖 `document_type/security_level/tags/entity_relations`，不能依赖可变路径。

### 6.2 文档模型

`documents` 是逻辑文档，`document_versions` 是不可变物理版本：

- 对象存储键：`projects/{project_id}/documents/{document_id}/versions/{version_id}/{safe_filename}`。
- 每版本保存 SHA-256、大小、MIME、上传者、来源、病毒扫描状态、解析器版本。
- 只允许一个 `is_current=true`，现有条件唯一索引可保留。
- 同项目同 checksum 可提示重复，但不要跨项目自动复用权限对象。
- 合同、投标、纪检材料配置 `security_level`、ACL、保留期限和水印/下载审计。

### 6.3 解析与索引流水线

`upload → virus_scan → parse/OCR → normalize → chunk → embedding → fulltext/vector index → quality_check → publish`

每一步写 `knowledge_index_jobs`，使用幂等键 `version_id + pipeline_version`；失败可重试，不覆盖旧版本索引；新版本完全建好后原子切换 current。

分块建议：

- 通用文档按标题层级 + 500–900 tokens，重叠 80–150 tokens。
- 合同按“章/条/款”，保留条款编号、甲乙方、金额、履约期等 metadata。
- 会议纪要按议题/决策/行动项，行动项同步提取为候选任务，人工确认后入业务表。
- 招投标按章节、评分项、资格条件、报价项。
- Excel 按工作表 + 表头语义 + 行组，不按纯字符强切。

### 6.4 Embedding 治理

不要永远把 embedding 固定在 chunk 行内且仅靠 1024 维常量。中期建议独立 `chunk_embeddings`：

- `chunk_id`
- `embedding_model_id`
- `embedding vector(N)`（同一模型维度固定；换维度需新表/分区或外部向量库）
- `content_hash`
- `created_at`

`embedding_models` 记录 provider/model/dimension/normalization/pipeline_version/status。这样模型升级可双写、灰度重建、回滚，不会破坏当前可用索引。

### 6.5 混合检索与权限

检索顺序：

1. 鉴权得到可访问 `project_id/document_id` 集合。
2. 解析过滤条件（文档类型、日期、实体关系、当前版本）。
3. 全文 BM25/tsvector 与向量 Top-K 并行召回。
4. RRF 融合，可选 reranker。
5. 返回 chunk、版本、页码、章节、权限、安全级别和引用。
6. AI 回答只引用当前版本，引用写入 `ai_citations`。

默认严格单项目检索；跨项目组合检索只能由有权限的组合知识空间显式开启，禁止因为向量相似自动跨项目召回。

## 7. 导入流程

1. 上传原始 Excel，先作为项目候选文档保存并计算 checksum。
2. 识别模板/页签/表头，生成预览，不直接写正式业务表。
3. 项目匹配：项目编码 > 明确项目名 > 文件名；冲突必须人工选择。
4. 标准化日期、状态、优先级、进度、多人/组织字段。
5. 校验 WBS 唯一性、日期范围、进度、父子关系和必填项。
6. 在单个事务内写入每个页签的结构化数据及 `import_row_records`。
7. 对已存在记录采用三方比对：上次导入值、当前系统值、新导入值；系统值被人工修改时不静默覆盖。
8. 导入完成生成审计摘要，原始 Excel 进入知识库并建立与导入批次、任务、里程碑等关系。

## 8. 实施优先级

### P0：先稳住数据边界

- 增加组织/人员/工作包/任务关系、导入血缘、文档类型与 ACL。
- 给现有高频项目列表和逾期查询补复合/条件索引。
- 强制所有知识检索带 `project_id`，修正中文全文检索策略。
- 建立 10 个项目与各自唯一知识库，原始 Excel 先归档、后结构化导入。

### P1：自动化导入与材料关联

- Excel 模板识别、预览、状态映射、三方合并。
- 文档与任务/里程碑/风险/会议/合同等实体关联。
- 周报快照和行动项提取。

### P2：规模化与智能治理

- 独立 embedding 模型/索引作业表，支持模型升级双轨索引。
- 大规模时对 chunks 按 project 哈希分区，或迁移到外部向量库的 project collection/tenant partition。
- 知识图谱只存高价值实体关系，不用图谱替代关系数据库。

## 9. 当前实现的直接判断

- PostgreSQL + pgvector + 对象存储的技术路线可继续使用。
- 当前 schema 已经能覆盖约 70% 的计划表核心字段；缺口主要是多方/多人关系、工作包、周报快照、导入血缘、文档分类与 ACL、embedding 版本治理。
- 当前 HNSW、GIN、文档版本唯一约束是良好基础；需要补充项目过滤索引、中文检索、模型版本和异步作业治理。
- 不建议为每个项目创建一套独立 PostgreSQL 表；应使用共享 schema + 强制 `project_id` 隔离。只有法规或物理隔离要求时才独立数据库/对象桶/向量 collection。
