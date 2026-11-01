# Project Adapter（只读）

此层仅调用既有项目 API，不注册路由，也不切换生产 Gateway。`contract.productionGateway` 必须保持 `false`，默认超时 8000ms。

## 安全契约

- `serviceToken` 必填，通过 `x-zh-service` 发送；实现禁止打印、记录或返回令牌。
- `projectId` 仅允许安全 ID 字符集；搜索 query 不得为空。
- 搜索与会话列表请求始终包含目标项目 ID，适配层不提供跨项目聚合或写操作；上游 ACL 负责拒绝跨项目访问。
- Abort 超时映射为 `adapter_timeout`。
- 401/403→`adapter_unauthorized`；404→`adapter_not_found`；其他 HTTP→`adapter_upstream_failed`；连接异常→`adapter_network_error`。

回滚：删除本 README 即可（客户端实现不受影响）。
