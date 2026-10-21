---
kind: upgrade-guide
description: "携带主体的转发事件需要应用授权策略，回执绑定准入的 Peer。"
---
# 为转发事件授权

[English](guide.md) | 中文

## 变更

Gateway 不再向未配置显式应用策略且携带主体的客户端广播通知或瀑布事件。事件回执必须匹配订阅的 Peer 与 issuer/id，因此另一会话不能使用其他客户端的 id 提交结果。不携带主体的 operator 客户端保留本地广播行为。已投递的瀑布事件在全部接收方失去授权后会拒绝源请求，不再无限等待；重连会在就绪之前重新检查当前授权。

## 迁移

1. 从应用插件注册一个 `ctx.typertGateway.registerRemoteEventPolicy()`。通过服务端权威状态解析事件归属，归属未知或权限已撤销时返回 false。不要信任客户端参数，也不要假定 Agent id 就是用户身份。
2. HTTP 回执与对应 WebSocket 订阅使用同一个准入 Peer。独立会话必须使用自己的事件流与客户端 id。
3. 验证两个用户只收到获准的通知与瀑布事件，伪造客户端 id 不会消费归属方投递，撤权后拒绝排队载荷与回执。卸载策略必须结束其事件流。生命周期与失败行为见 [Gateway 参考](../../../../packages/api/gateway/README.zh.md)。
