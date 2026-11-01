# 首轮知识库改造集成证据（非生产）

## 结论边界

本轮只建立首轮可审查集成版本：P0 安全测试、最小去标识化 manifest、默认 legacy 的 shadow 双读/回滚骨架、迁移清单证据与文档状态。未清库、未重嵌入、未运行高负载压测、未执行 5/20/50/100 真实生产灰度。

## 评测与双读

- 最小 manifest：`artifacts/kb-modernization/eval/kb-eval-20260917-0.1.0/manifest.jsonl`
- 固定 seed：`20260917`
- 双读策略：`apps/api/src/modules/knowledge/knowledge-read-rollout.ts`
- 默认值：`KNOWLEDGE_READ_MODE` 未设置、未知值或 `legacy` 均返回 legacy；仅显式 `shadow` 启动候选只读对账。
- shadow 永远 `servedBy=legacy`；候选异常只记录 `candidateError`，不影响 legacy 返回。
- 回滚：切回 `legacy`；`productionRolloutPercent=0`；无需删索引或重算向量。

## 迁移证据快照

- SQL 文件：`0000`—`0022`，`0021` 仅 `0021_project_import_change_tracking.sql` 一份；人工增量为 `0022_evidence_envelope_citations.sql`。
- Drizzle snapshot 文件仅至 `0008_snapshot.json`；未运行 `pnpm db:generate`，未恢复其可能生成的重复全量迁移。
- 手写 `0022_evidence_envelope_citations` 已按 `idx=21` 登记到 `database/migrations/meta/_journal.json`。调用 Drizzle `readMigrationFiles({migrationsFolder:'./database/migrations'})` 返回22项，末项首句为 `ALTER TABLE "ai_citations" ADD COLUMN "source_project_id" uuid`，证明 migrator 在不新增snapshot的情况下可发现0022。
- `0022` 只对 `ai_citations` 增列、建索引并回填；无 `DROP/TRUNCATE/DELETE`，不触碰 embedding。
- 回填保留旧行：来源项目/版本/分块来自关联表；checksum 使用 `coalesce(dv.checksum,d.checksum)`；capturedAt 回填原 `created_at`。
- 扩展修复已将0022改为可安全重放：DDL和索引使用 `IF NOT EXISTS`；回填以新字段自身 `coalesce` 为第一优先，不覆盖已有快照；目标版本/分块用相关子查询避免 PostgreSQL `UPDATE ... FROM` 非法引用目标别名。
- 隔离数据库测试执行完整迁移后对0022裸SQL连续重放两次，验证旧引用正确回填、已有 `sourceProjectCode/checksum` 保值、无重复数据，并比较 `document_chunks` embedding行数与有序文本哈希完全不变。未运行生产数据库迁移。

## 引用提示、持久化与预算

- Occamy 稳定结构化引用头坚持最小披露：`【文档:N】 → 层级 → 来源项目代码 → 文档 → 版本号 → 分块序号 → checksum → 页码 → 章节 → 相关度`；不向模型暴露 `sourceProjectId/versionId/chunkId/capturedAt`。模型输出的 `【文档:N】` 由服务端 `selectCitedEvidence` 映射回完整 EvidenceEnvelope，再用于持久化和回放。模型继续输出 `【文档:N】`，服务端以序号选取完整 EvidenceEnvelope。
- `completeProjectAiAnswer` 与 `finalizeProjectAiStreamAnswer` 现统一调用 `citationValues`，新引用均写入来源项目、版本、分块、checksum和capturedAt快照；读取继续用 `coalesce` 兼容旧空快照字段。
- `prepareProjectRag` 与 `answerProjectQuestion` 已移除隐蔽 `maxChars=4_000` 覆盖，统一使用 `OCCAMY_PROMPT_MAX_CHARS=24_000` 与 `OCCAMY_EVIDENCE_MAX_CHARS=12_000`。按中文最保守1字符≈1 token估算，24K提示仍低于32K上下文，预留约8K token给协议、历史和输出；12K证据上限防止证据吞噬规则与问题预算。
- `evidence-envelope.test.ts` 精确断言最小披露头、内部ID不进入证据段、`【文档:N】` 映射完整Envelope及24K硬限/12K证据预算；`evidence-envelope-persistence.integration.test.ts` 在隔离数据库断言同步/流式完整快照等价，并通过读取路径验证快照回放。旧空快照读取继续使用 `coalesce` 到文档/版本/分块及createdAt。

## 微信侧零变更

授权只读采集范围包括 `/home/lgsj/harness/weixin-account-manager`、真实运行路由 `/home/lgsj/.dsh/dsh-channels/runtime-agent-routes.json`、候选旧路径以及两个环境文件。本轮只枚举受保护文件路径并流式计算SHA-256，不输出env内容、不写入这些路径。

- 现场采集快照：`docs/evidence/kb-modernization/G6/weixin-protected-manifest.sha256`，共76个文件；实际覆盖根文件 `server.mjs/package.json`，以及存在的 `scripts(2)/migration(17)/data(7)/contracts(5)/storage(40)`、真实runtime route和两个环境文件。
- 覆盖限制：`src` 当前为0文件；旧channel目录与旧错误route路径不存在，均在 `weixin-protected-missing.txt` 真实记录，不伪造哈希、不与真实runtime route混淆。
- 校验：`node scripts/kb-modernization/verify-protected-manifest.mjs` 强制检查关键根文件、现存目录类别和真实runtime route，再逐文件流式复算；输出只含覆盖布尔/计数与 `contentsExposed:false`，manifest不含密钥值。
- 证据强度：该快照由本轮现场采集且无独立签名或可信时间戳，只能证明采集后保持稳定，不能单独证明整个实施历史周期从未变化；不得将其表述为受信实施前基线或全周期零变更证明。
- 未读取、迁移或修改微信个人知识库、记忆、周期报告、索引、路由或服务配置。

## 验证命令

```bash
pnpm test
pnpm typecheck
pnpm --dir ../bussiness-manager test
pnpm --dir ../bussiness-manager typecheck
```

完整 G6 最低样本量、三次离线重复和性能阈值仍属于后续门禁；本证据不得用来宣称 G7 已发布。
