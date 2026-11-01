# 智汇知识库生产发布报告（2026-09-17）

## 1. 发布范围

- 智汇·项目知识库与智能助手
- 智汇·商机知识库与分析助手
- OPP-MASTER 服务端授权组合空间
- Occamy 1.0 34.7B Q5_K_M（智汇32K）生成链路
- EvidenceEnvelope / ai_citations 增量迁移 0022

明确不包含微信机器人知识库、个人记忆、周期报告、索引、模型路由和服务配置改造。

## 2. 发布授权与制品

- 用户于本会话明确要求“现在正式投入使用”。
- 迁移：`database/migrations/0022_evidence_envelope_citations.sql`
- 迁移 SHA-256：`c06abbcb4c332cc0bab0441182a9c22ec8031aeeecbc34d9757ebd4a79f50d5c`
- Journal SHA-256：`f806c61030b6fdb17731d22b48bdbbb25d0ff86dba05e7f37ad48eedf8deeaf1`

## 3. 发布前检查与备份

- 项目 API、商机 API、LLM Wiki、pgvector、Redis、MinIO/对象存储与 DSH 健康检查通过。
- 生产数据库：`project_manager`，迁移前约 58 MB。
- 迁移前引用：9 条；EvidenceEnvelope 新列：0 个。
- 迁移前带 embedding 分块：710 条。
- 备份目录：`/home/lgsj/backups/zhihui-kb-release-20260917-142211`
- 原始自定义格式备份：`project_manager.pre-0022.dump`
- 原始备份 SHA-256：`5386ca9e7cdf0292424203fc2f92054564a0bcf083825f278400ef1d33ff0f50`
- PostgreSQL 16 兼容 SQL：`project_manager.pre-0022.pg16.sql`
- 兼容 SQL SHA-256：`173fd501be25fce6688f3bd425b09d0cbe59f97f942ded7f1c52422a606f8c43`

客户端为 PostgreSQL 17.9、服务器为 16.15；原始 dump 在恢复时包含服务器 16 不识别的 `SET transaction_timeout = 0`。保留原始 dump 不变，并额外生成只删除该会话参数的 PostgreSQL 16 兼容 SQL。

## 4. 迁移结果

执行：`pnpm db:migrate`

结果：

- Drizzle 迁移记录新增 ID 23；
- 迁移 hash 与审核制品 SHA-256 一致；
- 新增列：`source_project_id`、`source_project_code`、`version_number`、`chunk_index`、`checksum`、`captured_at`；
- 9 条历史引用的 `captured_at` 与 `source_project_id` 均无空值；
- 带 embedding 分块仍为 710 条。

## 5. 服务与模型启用

重启现有 systemd 服务：

- `project-manager-api.service`
- `opportunity-manager-api.service`

保持并验证：

- `project-manager-web.service`
- `opportunity-manager-web.service`
- `occamy-openai-proxy.service`
- `llm-wiki.service`
- `llm-wiki-vector.service`

全部为 `active`。

Occamy 验证：

- 模型：`occamy:1.0-q5-k-m-zhihui`
- 参数规模：34.7B
- 量化：Q5_K_M
- 项目和商机配置均为 `DSH_PROVIDER=occamy-local`、`DSH_MODEL=occamy:1.0-q5-k-m-zhihui`
- 项目端真实同步 RAG 返回 200，无证据时正确拒答，无 think/control 泄漏，测试会话已删除（204）。
- 商机端真实 Occamy 客户端调用通过，无 think/analysis/system 泄漏。

## 6. 授权与数据安全验证

- 普通项目 `scope=all-projects`：403 `knowledge_portfolio_forbidden`。
- OPP-MASTER `scope=all-projects`：200。
- 普通项目当前知识库：200。
- 默认读取策略：`legacy`；candidate 只读；生产候选比例 0%。
- 回滚策略：强制 `legacy`。
- 微信受保护 manifest：76 文件，复算通过；验证器未输出配置内容。

### 6.1 向量观察说明

迁移前后带 embedding 分块数量均为 710。服务重启触发既有个人日报周期任务，6 个个人报告分块 ID 被幂等轮换；旧/新分块向量 MD5 相同。按向量值多重集合计算：

- 迁移前 SHA-256：`2e62f3e2192fea8335ea1c7cd71c859eaa78d6ce2e1267ed62d3de9b29eab655`
- 发布后 SHA-256：`2e62f3e2192fea8335ea1c7cd71c859eaa78d6ce2e1267ed62d3de9b29eab655`

结论：0022 未修改向量值；个人日报调度器按既有逻辑刷新了行 ID。未调整、暂停或改写微信个人知识链路。

## 7. 回滚演练

- 原始 dump 的清单检查通过。
- PostgreSQL 16 兼容 SQL 已恢复到临时数据库。
- 临时恢复库带 embedding 分块：710。
- 恢复库 embedding 聚合哈希：`6eb108c36506f91ec007856bdc71792c`，与迁移前按 ID 聚合的基线一致。
- 恢复库 EvidenceEnvelope 新列数量：0，证明是 0022 之前的恢复点。
- 临时数据库已删除，未影响生产库。

## 8. 发布结论

本次生产发布成功：智汇·项目与智汇·商机已启用审核通过的授权隔离、EvidenceEnvelope、Occamy 智汇32K RAG 和引用兼容能力。未执行候选 shadow 索引切流，默认继续从 legacy 主索引提供结果；shadow/对账模块仍为后续候选索引接入骨架。

Open PM² 未核验候选材料仍保持 `blocked`，未发布、未索引。
