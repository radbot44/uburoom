# Upgrading

Private pre-release layouts have no supported automatic upgrade path. Published releases must provide explicit forward migrations when their supported baseline changes.

## Current storage contract

SQLite baseline **11** contains accounts with guest flags, identities, encrypted credentials, logins, audit, playback history, durable rooms (including slugs, phonetic words, invite codes and guest admission rules), room hosts, completion progress, playback queues and history, room invite memberships and blocks, and scheduled room events. The runtime creates this layout only for an empty installation and reopens complete baseline-11 databases without replacing UUIDs or ciphertext.

Older private, incomplete, unversioned or newer layouts fail unchanged. Legacy JSON is not imported. Startup and deployment neither reset state nor run private migrations.

Writes use one direct SQLite connection with WAL, synchronous=NORMAL and foreign keys enabled. Short statements and transactions commit before successful responses; a storage failure must not report successful persistence. A process crash preserves acknowledged writes; sudden power loss can lose recent commits with synchronous=NORMAL. Graceful shutdown checkpoints with wal_checkpoint(TRUNCATE) before closing, returning the database to a single file.

## Retaining state

1. Select a tested code revision and review its configuration/schema requirements.
2. Stop the server for a matched offline backup, or use SQLite's supported online backup mechanism. An online file snapshot must include the database and its matched -wal file; copying the database alone while WAL is active can omit committed writes. Include database/state, private YAML, TLS and the **exact original 32-byte credential key**. Restrict access, verify hashes and SQLite integrity.
3. Test a copy with the original key in isolation. Preserve UUIDs, verified identity links, encrypted records, roles and history.
4. If the layout is rejected, use a reviewed private transfer or an explicitly approved reset. Never delete state or replace its key merely to make startup pass. Keep private migration scripts outside distributed source and verify repeat-run idempotence.
5. Install dependencies on the runtime host and restart only in an approved maintenance window. Verify health, accounts and durable state before declaring success.

Set `storage.credential_key_file` outside the project or preserve the existing platform-default location; see [self-hosting](self-hosting.md#configuration). Keep state independent of replaceable code directories. No automatic key discovery/relocation is performed.

## Rollback

Keep prior code and a matched restricted backup. Code rollback alone does not restore schema/state. Crossing incompatible layouts requires a deliberate matched restore and can discard subsequent changes, including sign-outs and revocations. Do not pair a database with a newly generated key.

Historical pre-release configuration versions and prior schema transfer notes are superseded by the selected code, [configuration example](../config.example.yaml) (schema v2o) and baseline 11 above. Offline fixture success is not operator restore verification; open checks remain in [testing](testing.md).
