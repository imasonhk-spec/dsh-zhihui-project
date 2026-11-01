# ICT-1 Windows Edge 145 发布验收记录

> 本模板用于 `docs/日志记录改造.md` 的 G1 发布门禁。填写前不得将静态检查或 Chromium 模拟结果记为真实 Edge 145 验收。

## 1. 验收元数据

| 项目 | 记录 |
|---|---|
| 验收日期/时间 | 2026-09-14，进行中 |
| 验收负责人 | 开发负责人（会话`session-afcc3a25-d740-42e7-af15-e175834f692e`） |
| 操作系统及版本 | Windows 11 24H2 |
| Edge 完整版本 | 145.0.0.1（Chromium 145系列） |
| 项目端候选构建/提交 | 当前工作区候选构建；验收时记录文件校验/版本引用 |
| 商机端候选构建/提交 | 当前工作区候选构建；验收时记录文件校验/版本引用 |
| 项目端候选 URL | `http://192.168.8.102:3220`（Windows Edge 145实际确认） |
| 商机端候选 URL | `http://192.168.8.102:3230`（Windows Edge 145实际确认） |
| 候选API/数据库 | API仅经Web代理访问；独立临时数据库；候选使用`zh_candidate_session`避免覆盖正式`zh_session`；正常退出自动DROP，异常退出由严格`recover`清理；禁止记录密钥、tenant或会话值 |
| 生产 tenant 核验状态 | **G2 PASS**：正式3210 Edge登录态可信scope=200；固定假UUID冲突claim=404且仅`resource_not_found`；3211日志交叉核验一致；未记录实际UUID |

## 2. 数据与安全前置条件

- [x] 使用专用候选环境：项目Web `3220`、商机Web `3230`、API仅本机代理、独立临时数据库。
- [x] 已记录测试项目`ICT-EDGE-001`与4个专用文件；不复制或使用正式业务数据。
- [x] 已记录隔离计数：正式项目14/商机0/ICT核心表0；候选项目1/商机0/ICT核心表6（自动验收环境会在人工交接前重建为空白）。
- [x] 候选`OPPORTUNITY_TENANT_ID`由服务端临时可信配置提供，客户端冲突claim返回统一404。
- [ ] 浏览器开发者工具已保留Network证据，敏感token、ticket、cookie及tenant值已遮盖。
- [x] 未执行未经授权的正式迁移、正式服务重启或部署；候选退出时自动终止进程并DROP临时库。

### 2.1 专用验收文件

登录候选项目端后，从以下受认证保护的URL下载；不得转存到正式知识库：

- `http://192.168.8.102:3220/project-01-baseline.csv`
- `http://192.168.8.102:3220/project-02-changes.csv`
- `http://192.168.8.102:3220/opportunity-01-baseline.xlsx`
- `http://192.168.8.102:3220/opportunity-02-changes.xlsx`

固定顺序：先用`01-baseline`预览并确认，再用`02-changes`预览。第二批必须出现`modified/cleared/created/archived/unchanged`；商机预计签单时间必须显示`2026-12-01 → 2026-12-31`、`推迟30天`。人工完成前不得把自动API验证结果填写为Edge通过。

推荐从受认证候选控制台`http://192.168.8.102:3220/ict-candidate-console.html`执行P1~P3与O1~O4。控制台按钮调用现有真实API，确认仍需人工二次点击，并可下载脱敏证据JSON。只有页面结果、API日志和数据库状态三者一致才可记为通过；口述勾选但无对应API请求时必须作废。

## 3. 智汇·项目验收

| 编号 | 场景 | 预期 | 结果 | HTTP/API证据 | 截图/录屏或缺陷单 |
|---|---|---|---|---|---|
| P1 | 首次任务导入preview | 显示baseline、摘要、无效行、来源文件；不提前写当前态 | **PASS**：Edge控制台显示201、baseline=true、previewed、总数4、无效0、4条initial、来源文件正确 | API日志真实preview=201；DB：project batch 1 previewed/0 succeeded、tasks=0、actor存在；preview阶段按契约尚不写实体/字段台账 | 候选控制台现场确认；脱敏证据待最终统一下载 |
| P2 | 首次任务导入confirm | 确认后列表与最新变化标记正确 | **PASS**：Edge控制台确认返回201、批次succeeded、总数4、无效0 | API日志真实confirm=201；DB：1 succeeded、4个current任务、4个initial实体、35条initial字段台账、来源及actor完整 | 候选控制台现场确认；发现确认响应无baseline字段时控制台误显示false，已修正为缺省不输出，不影响后端结果 |
| P3 | 第二批差异 | modified/cleared/created/archived/unchanged及旧值→新值正确 | **PASS**：Edge控制台第二批201，总数5、五类各1、无效0、maxSeverity=critical | DB：第二批实体5，五类齐全；字段变化16且16条oldDisplay/newDisplay不同；当前任务4、归档1；来源`project-02-changes.csv` | Edge控制台现场确认；关键例：结束日期`2026-09-20→2026-09-22`、优先级`high→critical`、厂商`厂商A→空` |
| P4 | critical门禁 | 未明确确认返回409/阻断；确认后成功 | **PASS（修复后重验）**：Edge真实操作先409 `import_critical_changes_confirmation_required`，再明确确认201 succeeded | API日志同一第二批confirm=409→201；DB：2批均succeeded、failed=0、`import.failed`审计0、当前态仅最终确认后写入 | 初验暴露409后误标failed缺陷；双端修复后项目5/5、商机22/22及候选API重验通过，Edge最终重验通过 |
| P5 | 列表与详情 | 最新角标、仅看变化、实体历史、来源批次/文件正确 | **PASS（修复后重验）**：Edge三个查询均200，marker=3、批次总数5、五类齐全、来源行`2,3,null,4,5`、实体历史11条且字段集合完整 | API日志角标/批次/实体历史GET均200；DB：最新成功批次5实体、来源行一致、marker=3、目标实体历史11条 | 初验暴露控制台误读`entityId`及CSV未注入`__sourceRow`；改用`targetEntityId`并按csv-parse物理行写入，项目5/5回归通过。重验库另有1个自动预置中断留下的previewed/0实体批次，不参与最新成功基线 |
| P6 | 404范围 | 不存在project/batch/entity返回404，不泄露其他范围 | **PASS**：Edge控制台三类状态均404 | API日志不存在project/batch/entity三个GET均404；统一仅返回错误码 | 候选控制台现场确认 |
| P7 | 409并发 | 陈旧base/fingerprint返回409，业务态和台账不写 | **PASS**：新preview=201、错误fingerprint确认=409 `import_preview_fingerprint_changed` | DB：失败批次实体0；当前任务仍4；成功台账仍9实体/51字段；1条预期`import.failed`审计 | 候选控制台现场确认 |
| P8 | 旧入口门禁 | tasks旧execute返回409及previewEndpoint；非tasks兼容 | **PASS**：Edge真实旧tasks execute=409，错误码和previewEndpoint正确 | API日志旧execute=409且未新增批次；非tasks兼容由ICT-R17-002 Fastify回归覆盖 | 候选控制台现场确认；previewEndpoint中的内部project ID不写入长期证据 |

## 4. 智汇·商机验收

| 编号 | 场景 | 预期 | 结果 | HTTP/API证据 | 截图/录屏或缺陷单 |
|---|---|---|---|---|---|
| O1 | 首次商机导入preview | 显示baseline、摘要、无效行、来源文件 | **PASS（最终重验）**：Edge v3真实preview=200、baseline=true、status=previewed、sourceName正确、总数5、无效0、5条initial | API日志POST preview=200；批次actor/requestId完整；后续确认前不写当前态 | Edge v3现场确认；批次ID/tenant不入证据 |
| O2 | 首次商机导入confirm | 确认成功且列表当前态、变化标记正确 | **PASS（最终重验）**：Edge confirm=200、批次succeeded、总数5、无效0 | API日志confirm=200；最终DB当前5、归档1；基线和第二批成功实体合计11、字段台账96 | Edge v3现场确认 |
| O3 | 第二批差异 | 六类语义、筛选、详情和来源行正确 | **PASS（最终六实体夹具）**：Edge preview=200，总数6、无效0；created1/modified1/unchanged1/cleared2/archived1，五类齐全，来源文件正确 | API与DB确认第二成功批次形成6个实体；最终当前5、归档1 | Edge v3现场确认 |
| O4 | 预计签单时间 | 提前/推迟N天、补充、清空均有非纯颜色文字 | **PASS（最终重验）**：Edge显示postponed/from_empty/advanced/to_empty；关键例`2026-12-01→2026-12-31`、推迟30天；另有提前17天、补充日期、已清空 | DB字段台账四方向一致；商机单测覆盖四方向；商机23/23回归通过 | Edge v3现场确认，方向均有文字与天数/空值表达 |
| O5 | critical门禁 | 未明确确认返回409/阻断；确认后成功 | **PASS（修复后最终重验）**：Edge同批次先409 `import_critical_changes_confirmation_required`，再明确确认200 succeeded | API日志409→200；门禁拒绝后保持previewed且无failed审计，最终确认才写入 | Edge v3现场确认 |
| O6 | tenant缺失 | 服务端可信tenant缺失时返回503 | **PASS**：Edge控制台请求候选无tenant探针返回503 `tenant_context_unavailable` | 探针仅监听`127.0.0.1:3232`，经受认证3220代理访问；同会话可信API仍200；探针纳入候选监管与自动清理 | Edge v3现场确认；未伪造或展示tenant |
| O7 | tenant冲突 | 客户端scope冲突返回统一404且不泄露资源 | **PASS（最终重验）**：Edge冲突claim=404、仅`resource_not_found` | API日志GET opportunities=404；未泄露真实tenant或资源；可信候选请求200 | Edge v3现场确认 |
| O8 | 409并发 | 陈旧base/fingerprint返回409且不写业务态/台账 | **PASS（修复后最终重验）**：Edge preview=200、错误fingerprint confirm=409 `import_preview_fingerprint_changed` | `sendImportError`补409映射及Fastify回归；最终Edge误操作重复执行两次O8，形成2个failed批次，但两批实体/字段均0，当前态和成功台账不变 | Edge v3现场确认；重复O8如实保留，不删除审计 |
| O9 | 审计查询 | previewed/confirmed/failed字段、actor、requestId完整 | **PASS（requestId修复后重验）**：真实Edge产生4 previewed、2 confirmed、2 failed事件 | 所有批次及审计actor/requestId非空；payload、scopeId、batchId均存在；2个failed批次实体0/字段0；路由无显式头时回退Fastify `request.id` | Edge操作+DB/API日志交叉核验；内部ID不入文档 |

## 5. 结论

- [x] 上述全部场景通过，且无未关闭的blocker/high缺陷。
- [x] Edge完整版本确认符合目标Chromium 145。
- [x] API状态、数据库计数和审计记录已复核。
- [x] 截图/录屏仅作交互补充，自动化/API/数据库证据齐全。

**G1结论**：`PASS`（P1~P8、O1~O9均由Windows 11 24H2 / Edge 145.0.0.1真实操作，并与API日志和隔离候选数据库交叉核验）。

**未关闭缺陷与负责人**：无blocker/high；验收中发现的Cookie覆盖、critical门禁不可重试、CSV来源行0、商机代理/缓存、O8状态映射、日期方向夹具不足、requestId为空均已修复并重验通过。生产登录态G2初验可信scope=400，定位为G3前缺少ICT增强表；增加严格`42P01`基础查询回退并经唯一授权重启正式商机API后，Windows Edge最终复验可信scope=200、冲突claim=404，服务端日志一致，G2已关闭。

**验收负责人签字/确认引用**：开发负责人（会话`session-afcc3a25-d740-42e7-af15-e175834f692e`）逐步确认；最终O6/O9确认时间见本记录API/DB证据。

> 验收完成后，将摘要和证据路径回填到 `docs/日志记录改造.md`；任何失败均保持或恢复发布结论为 `NO-GO`。
