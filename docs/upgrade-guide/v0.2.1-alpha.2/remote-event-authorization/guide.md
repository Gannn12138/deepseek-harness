---
kind: upgrade-guide
description: "Principal-bearing forwarded events require an application authorization policy and receipts are bound to the admitted Peer."
---
# Authorize forwarded events

English | [中文](guide.zh.md)

## Change

Gateway no longer broadcasts forwarded notifications or waterfalls to principal-bearing Clients without an explicit application policy. Event receipts must match the subscribed Peer and issuer/id, so a different session cannot submit a result using another Client's id. Operator Clients without a principal retain local broadcast behavior. Previously delivered waterfalls whose recipients all lose authorization now reject their source instead of waiting indefinitely; current authorization is checked again on reconnect before readiness.

## Migration

1. Register one `ctx.typertGateway.registerRemoteEventPolicy()` contribution from the application plugin. Resolve event ownership from authoritative server state and return false for unknown ownership or revoked access. Do not trust Client parameters or assume an Agent id identifies a user.
2. Keep the same admitted Peer for HTTP receipts and the corresponding WebSocket subscription. A separate session must use its own event stream and Client id.
3. Verify two users receive only authorized notifications and waterfalls, forged Client ids fail without consuming the owner's delivery, and revoked access rejects queued payloads and receipts. Withdrawing the policy must end its event streams. See the [Gateway reference](../../../../packages/api/gateway/README.md) for lifecycle and failure behavior.
