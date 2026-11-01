# ICT-1 G3 Windows Edge 145 迁移后验收记录

> 本模板仅用于正式G3迁移完成后的兼容性冒烟。不得在正式环境执行导入、创建商机或修改业务数据来制造证据；不得把自动curl、Chromium模拟或历史G1/G2结果填写为本轮真实Edge结果。

## 1. 验收元数据

| 项目 | 记录 |
|---|---|
| 验收时间 | 待填写 |
| 验收负责人 | 开发负责人（会话`session-afcc3a25-d740-42e7-af15-e175834f692e`） |
| 操作系统 | Windows 11 24H2 |
| Edge完整版本 | 145.0.0.1 |
| G3执行审计文件 | 待填写文件名，不粘贴内部路径以外敏感内容 |
| G3自动验证证据文件 | 待填写文件名 |
| PG16 verified恢复点 | 待填写本次`.tmp/ict-g3-differential-restore-point-*`文件名（仅记录状态与SHA引用，不记录连接串） |
| 验收前发布状态 | `NO-GO / AUTOMATED_PASS_EDGE_PENDING` |

## 2. 自动门禁前置条件

- [ ] G3执行器输出`G3_APPLY=PASS`与`RELEASE_STATE=READY_FOR_EDGE_G3_SMOKE`。
- [ ] 发布后验证器输出`G3_POST_VERIFY=AUTOMATED_PASS_EDGE_PENDING`。
- [ ] journal=21、ICT表=8、项目/商机约束=18/23、商机新增列=4。
- [ ] 业务计数和项目ICT/import_jobs台账与本次权限600的`ict-g3-authorized-final-watermark-*`冻结水位完全一致；商机台账保持2/128/813/1/5。
- [ ] production自动验证全程只读，未执行任何项目或商机写入探针。
- [ ] 四服务均`active/running/success/NRestarts=0`，双Web与双API health为200，未认证业务请求为401。
- [ ] 自动证据文件权限600，且不含Cookie、Tenant、Token、连接串或内部实体ID。

任一项不满足：停止Edge验收，发布保持`NO-GO`。

## 3. Windows Edge 145迁移后冒烟

| 编号 | 场景 | 操作 | 预期 | 结果 | 脱敏证据引用 |
|---|---|---|---|---|---|
| E1 | 正式项目登录态 | 在Edge打开正式项目端并刷新 | 登录态有效，不出现401循环 | 待执行 | 待填写 |
| E2 | 项目列表兼容 | 打开项目列表 | 正常展示，项目总数14 | 待执行 | 待填写 |
| E3 | 项目任务读取 | 打开既有项目任务页，仅查看 | 正常返回；数据库任务总数与冻结水位一致 | 待执行 | 待填写 |
| E4 | 正式商机登录态 | 在Edge打开正式商机端并刷新 | 登录态有效，不出现401循环 | 待执行 | 待填写 |
| E5 | 可信Tenant范围与增强查询 | 正常打开商机列表，不手工构造Tenant；在Network响应中只检查计数与字段名 | HTTP 200，total=64且与冻结水位一致；记录可只读访问，响应契约包含`latestImportChange`键；不记录内部商机UUID | 待执行 | 待填写 |
| E6 | 冲突Tenant防泄漏 | 使用固定假UUID发送冲突`x-tenant-id`请求 | HTTP 404，仅`resource_not_found` | 待执行 | 待填写 |
| E7 | 无业务写入 | 验收后复核页面与自动证据 | 验收期间未执行导入、创建、修改、删除；项目和商机台账与冻结水位一致 | 待执行 | 待填写 |
| E8 | 服务与数据库回看 | 由发布负责人执行只读复核 | 四服务`active/running/success/NRestarts=0`；业务计数、项目台账和import_jobs与冻结水位一致；商机台账2/128/813/1/5 | 待执行 | 待填写 |

## 4. 敏感信息规则

以下内容不得写入本文件、截图说明或聊天证据：

- `zh_session`、`zh_candidate_session`实际值；
- 实际`OPPORTUNITY_TENANT_ID`；
- 服务Token、Ticket、密码、数据库连接串；
- 批次、项目、商机、实体内部UUID；
- 浏览器请求头中的Cookie或Authorization值。

允许记录：HTTP状态码、固定假UUID已使用的事实、脱敏错误码、计数、文件SHA-256、服务状态、Edge与操作系统版本。

## 5. 结论

- [ ] E1~E8全部PASS。
- [ ] 自动门禁与Edge证据属于同一次G3执行。
- [ ] 没有执行正式导入或业务写入。
- [ ] 没有未关闭的blocker/high问题。

**最终结论**：待填写`GO`或`NO-GO`。

- 任一失败：立即记为`NO-GO`，停止开放项目ICT写入口并人工处置。正式环境已有项目批次，public-only结构回滚已永久禁止；商机台账同样不可回滚。
- 全部通过：才可将`docs/日志记录改造.md`更新为G3 PASS，并另行确认是否开放导入入口。
