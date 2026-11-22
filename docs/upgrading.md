# Upgrading

Private pre-release layouts have no supported automatic upgrade path. Published releases must provide explicit forward migrations when their supported baseline changes.

## Current storage contract

SQLite baseline **13** adds `uburoom_accounts` on top of baseline 12's nullable per-room buffering override alongside the existing account, room, queue, and scheduled-event schema. An unset override follows the server configuration. The runtime creates this layout for an empty installation and reopens compatible databases with their existing UUIDs and ciphertext. Existing earlier private pre-release installations require an explicit offline transfer or reset.

Older private, incomplete, unversioned or newer layouts fail unchanged. Legacy JSON is not imported. Startup and deployment neither reset state nor run private migrations.

Writes use one direct SQLite connection with WAL, synchronous=NORMAL and foreign keys enabled. Short statements and transactions commit before successful responses; a storage failure must not report successful persistence. A process crash preserves acknowledged writes; sudden power loss can lose recent commits with synchronous=NORMAL. Graceful shutdown checkpoints with wal_checkpoint(TRUNCATE) before closing, returning the database to a single file.

Before startup writes, uburoom authenticates all stored credential and OAuth envelopes, including expired or context-mismatched browser logins, with the selected key. A stored encrypted key canary also detects a replacement key when no credentials remain. An installation without a canary receives one only after its existing encrypted records pass validation; an empty installation has no older ciphertext with which to prove a prior key. An authentication failure leaves login/context and retention data unchanged. Restore the original key and matched database; do not generate a replacement key to bypass the failure.

File-backed databases have a cooperative instance lock beside the canonical database path (`accounts.sqlite.lock` by default). A second uburoom instance fails before opening SQLite; read-only doctor and supported online backup access remain available. The filesystem must support atomic hard links for complete lock records. Graceful close removes the lock, and startup can recover a dead PID on the same host. Unknown ownership, another host/container, an apparently live or reused PID, or an interrupted `.lock.recovery` guard fails closed. PID checks apply within the current host/PID namespace. After a container replacement or interrupted recovery, confirm that **no instance uses the database** before removing only the stale `.lock` / `.lock.recovery` records. Never remove them from a running installation. These are process ownership records, not backup state; do not copy them into a restored installation. Preserve the database, WAL, original credential key and private configuration.

## Retaining state

1. Select a tested code revision and review its configuration/schema requirements.
2. Stop the server for a matched offline backup, or use SQLite's supported online backup mechanism. An online file snapshot must include the database and its matched -wal file; copying the database alone while WAL is active can omit committed writes. Include database/state, private YAML, TLS and the **exact original 32-byte credential key**. Restrict access, verify hashes and SQLite integrity.
3. Test a copy with the original key in isolation. Preserve UUIDs, verified identity links, encrypted records, roles and history.
4. If the layout is rejected, use a reviewed private transfer or an explicitly approved reset. Never delete state or replace its key merely to make startup pass. Keep private migration scripts outside distributed source and verify repeat-run idempotence.
5. Install dependencies on the runtime host and restart only in an approved maintenance window. Verify health, accounts and durable state before declaring success.

Set `storage.credential_key_file` outside the project or preserve the existing platform-default location; see [self-hosting](self-hosting.md#backups-and-upgrades). Keep state independent of replaceable code directories. No automatic key discovery/relocation is performed.

## Rollback

Keep prior code and a matched restricted backup. Code rollback alone does not restore schema/state. Crossing incompatible layouts requires a deliberate matched restore and can discard subsequent changes, including sign-outs and revocations. Do not pair a database with a newly generated key.

See the selected code's [configuration example](../config.example.yaml) and the storage baseline above. Note that `secrets.server_password` now requires at least 8 characters when `access.password` is enabled; hand-edited server passwords shorter than eight characters block startup until updated. For restore verification, see [testing](testing.md).
