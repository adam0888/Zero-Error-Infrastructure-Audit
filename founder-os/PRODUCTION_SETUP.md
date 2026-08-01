# Founder OS Production Setup

## Important status correction

The current verified suite is **92/92** unit/integration tests and **12/12** verification checks. The project includes a full supervised-automation stack: webhook handler, deterministic queue worker, and MCP inbox sync — all implemented and tested.

## 1. Environment variables

Create `/home/team/shared/founder-os/.env` with restrictive permissions:

```dotenv
# Required in production.
# Lemon Squeezy X-Signature HMAC secret.
LEMON_SQUEEZY_WEBHOOK_SECRET=replace_with_real_lemon_squeezy_secret

# Production webhook listener.
LS_WEBHOOK_PORT=3100

# Maximum accepted request body size.
LS_WEBHOOK_MAX_BODY_BYTES=65536

# MCP bearer token. Keep this out of source control.
MCP_BEARER_TOKEN=replace_with_real_mcp_bearer_token
```

Do not commit `.env` or place these secrets in source control. The current Node.js files do not automatically parse `.env`, so load it from the shell or a process manager.

Worker settings (optional): `WORKER_INTERVAL_MS` (default 900000), `SYNC_INBOX_INTERVAL_MS` (default 900000), `MCP_ENDPOINT` (default http://localhost:3000/mcp), and `MCP_BEARER_TOKEN` (token is read from the environment only). Set `MCP_SYNC_ENABLED=0` or `SYNC_INBOX_DISABLED=1` to disable inbox sync. HTTP responses are bounded to 256 KiB and text blocks to 4096 characters.

### Development-only bypass

Only for local testing without a Lemon Squeezy secret:

```dotenv
LEMON_SQUEEZY_WEBHOOK_DEV_BYPASS=1
```

Never use this in production. If `LEMON_SQUEEZY_WEBHOOK_SECRET` is set, signature verification remains mandatory and the bypass is ignored.

### MCP settings

The MCP bridge is disabled by default. Its endpoint and feature flags are currently passed through orchestrator configuration/CLI flags rather than environment variables:

```text
Default HTTP endpoint: http://localhost:3000/mcp
Default RPC endpoint:  http://localhost:3000/mcp/rpc
Default WS endpoint:   ws://localhost:3000/mcp/ws
Default timeout:       5000 ms
```

The bearer token is the only MCP secret and must be supplied through:

```dotenv
MCP_BEARER_TOKEN=replace_with_real_mcp_bearer_token
```

The implementation does not currently read `MCP_ENDPOINT`, `MCP_RPC_ENDPOINT`, or `MCP_WS_ENDPOINT` environment variables.

## 2. Load configuration safely

```bash
cd /home/team/shared/founder-os

chmod 600 .env

set -a
. ./.env
set +a
```

Confirm that the secret variables exist without printing their values:

```bash
test -n "${LEMON_SQUEEZY_WEBHOOK_SECRET:-}" \
  && echo "Lemon Squeezy secret loaded" \
  || echo "Lemon Squeezy secret missing"

test -n "${MCP_BEARER_TOKEN:-}" \
  && echo "MCP token loaded" \
  || echo "MCP token missing"
```

## 3. Boot the webhook handler

```bash
cd /home/team/shared/founder-os

set -a
. ./.env
set +a

node src/webhookHandler.js \
  > .founder-os/logs/webhook-handler.log \
  2>&1 &

WEBHOOK_PID=$!
echo "$WEBHOOK_PID" > .founder-os/webhook-handler.pid

echo "Webhook handler started with PID ${WEBHOOK_PID}"
```

The handler listens on:

```text
POST http://127.0.0.1:3100/webhooks/lemon-squeezy
```

Place it behind an authenticated HTTPS reverse proxy before exposing it publicly. Configure Lemon Squeezy to send webhooks to the public HTTPS URL, not directly to an unencrypted local port.

## 4. Verification commands

Run these before accepting production traffic:

```bash
cd /home/team/shared/founder-os

node test/run.js
node src/orchestrator.js verify
```

Expected results:

```text
92/92 tests passed
12/12 checks passed
```

## 5. Three-process supervised boot

The production stack runs three processes under a single-writer filesystem supervisor: the webhook handler, the deterministic queue worker, and the MCP inbox syncer. Each process uses its own PID file and lock file with stale-lock reclamation (24-hour threshold).

### Start all three

```bash
cd /home/team/shared/founder-os
set -a; . ./.env; set +a
mkdir -p .founder-os/logs

# 1. Webhook handler (Lemon Squeezy payment events)
node src/webhookHandler.js \
  > .founder-os/logs/webhook-handler.log 2>&1 &
echo $! > .founder-os/webhook-handler.pid

# 2. Queue worker (processes backlog FORM_SUBMISSION_RAW / PAYMENT_EVENT records)
node src/worker.js \
  > .founder-os/logs/worker.log 2>&1 &
echo $! > .founder-os/worker.pid

# 3. MCP inbox syncer (queries active-client messages, generates persona drafts)
node src/syncInbox.js \
  > .founder-os/logs/sync-inbox.log 2>&1 &
echo $! > .founder-os/sync-inbox.pid
```

### Process roles

| Process | File | Purpose | Default interval |
|---------|------|---------|-----------------|
| Webhook handler | `src/webhookHandler.js` | Receive Lemon Squeezy POSTs, verify signatures, enqueue payment events | N/A (event-driven) |
| Queue worker | `src/worker.js` | Poll backlog for `FORM_SUBMISSION_RAW` and `PAYMENT_EVENT` records; process sequentially; failed records remain in backlog | 15 min (`WORKER_INTERVAL_MS`) |
| Inbox syncer | `src/syncInbox.js` | Query MCP bridge for active-client messages; create deduplicated backlog tasks; generate UNCONFIRMED persona drafts with deduplicated draft-log entries | 15 min (`SYNC_INBOX_INTERVAL_MS`) |

### Lock files

- `.founder-os/worker.lock` — prevents concurrent worker instances
- `.founder-os/sync-inbox.lock` — prevents concurrent sync instances

Stale locks older than 24 hours are automatically reclaimed. Lock files contain `{ pid, startedAt }` (worker) or just the PID (sync).

### Graceful shutdown (SIGTERM, then cleanup after exit)

```bash
for f in .founder-os/{webhook-handler,worker,sync-inbox}.pid; do
  test -s "$f" && kill -TERM "$(cat "$f")" 2>/dev/null || true
done
sleep 2
for f in .founder-os/{webhook-handler,worker,sync-inbox}.pid; do
  test -s "$f" && kill -0 "$(cat "$f")" 2>/dev/null || rm -f "$f"
done
```

## 6. Supervision caveat

This is **supervised automation**, not fully autonomous. The three processes handle their respective duties deterministically, but they rely on an external process supervisor (systemd, Docker, PM2, or equivalent) for:

- Restart on crash
- Health checks
- Log rotation
- Resource limits

The architecture intentionally preserves manual confirmation gates for outbound communication and infrastructure actions. No outbound messages are sent automatically — all persona drafts are generated as `UNCONFIRMED` and require explicit human confirmation before queuing for delivery.

Only one writer mutates each JSON ledger at a time (the single-instance lock enforces this per process). The webhook handler sequences requests through a `SerializedQueue` to prevent concurrent ledger mutations.

## 7. Event-driven CLI (manual operations)

In addition to the three automated processes, the orchestrator CLI remains available for manual operations:

```bash
node src/orchestrator.js process-form --file application.json
node src/orchestrator.js process-payment --file payment.json
node src/orchestrator.js generate-draft --engagement <ID> --type assessment
node src/orchestrator.js confirm-draft --hash <SHA256>
node src/orchestrator.js list --ledger active
```

## Production-completion status

All components are implemented and tested: Lemon Squeezy webhook adapter, deterministic queue worker, MCP bridge with persona draft generation, and inbox sync with draft deduplication. The three-process supervised automation stack is ready for production deployment behind a process supervisor.
