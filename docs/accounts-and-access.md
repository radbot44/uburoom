# Accounts, administration and Plex reporting

Current: YAML configuration, admission/password policies, configured sponsorship, Activity handoff, single-room operation and [names/host assignments](account-names-and-host-directory.md) are implemented. The administration panel, broader identity hardening, product Plex reporting and guest passes remain unfinished.

## Authorization contract

| Layer | Authority |
| --- | --- |
| Identity | Canonical UUID plus verified provider subjects; names grant nothing |
| Sign-in | Configured Plex/Discord methods; both off allows anonymous visitors, not guest passes |
| Admission | Current provider/Plex/password rules and verified Activity context |
| Media | Current personal Plex entitlement or explicitly configured sponsorship |
| Room roles | Viewer, host, creator and explicit Admin override; none grants Plex entitlement |
| Reporting | Actual verified Plex subject, independently of the source/encoder credential |

**Approved sharing policy:** Fallback is enabled by default for eligible viewers without an attached Plex account or with confirmed server nonmembership when personal access is not required. Removing a Plex link can therefore permit configured sponsorship. This is an explicit operator choice, not personal entitlement. Revoked/expired credentials, provider errors and item denials fail closed. Dedicated non-owner direct delegation is a separate opt-in. See [operator settings](self-hosting.md#shared-plex-fallback).

Recheck authority around awaited work across sockets, catalogs, artwork, captions, queues and media. Planned canonical deny/revocation rules must take precedence over alternate providers and passes. Finer-grained source/library/item/audience grants remain future work; do not describe them as implemented.

## Configuration and administration

Before building the panel:

- Inventory each setting's type/default, validation, secret status, authority, persistence, restart requirement and effect on active viewers.
- Decide how editing preserves YAML authority or explicitly approve a secrets/mutable-settings split. Never expose the secret-bearing file or create competing stores.
- Define operator bootstrap/recovery for Plex, Discord or both; prevent loss of the last administrative sign-in. Room Admin mode is not global configuration authority.
- Require validated, authorized, durable changes with audit/revocation behavior and clear pending/restart/error states. Saving cannot implicitly restart services or alter provider registration.

Validate the effective-policy matrix: each provider alone/linked/disabled, required Plex access, absent versus revoked credentials, membership loss, sponsorship, account merge/deny and existing sessions after policy changes.

## Sensitive account changes

Remaining work: recent proof of the initiating account for link/unlink/merge, proof of incoming identities, last-usable-login protection, session revocation and recovery. Preserve conflict rejection, canonical UUIDs and role/history consequences. Routine watching and authorized handoff must remain usable without repeated reauthentication.

Cover replayed/expired callbacks, mismatched browsers/accounts, concurrent changes, revocation during provider calls, stale merge previews and failed durable writes. Manual provider assignments are not verified identities. Existing name search and pending host assignments are described in their [own contract](account-names-and-host-directory.md); do not reimplement them.

## Discord Activity and browser handoff

Preserve one-use expiring handoff authorization, source-grant/browser binding and confirmation for an existing browser-account mismatch. Carry the same account and current policy into the browser. The Activity exception to required Plex access never exempts browser entry; Activity-only installations permit browser account management, not browser playback.

Further Plex-only/Activity association work must bind fresh Plex proof to the exact pending attempt and distinguish temporary context from permanent linking. Discord context alone cannot silently enroll a login, enable a disabled provider or grant media access. Verify real SDK/proxy behavior separately from fixtures.

## Plex activity and viewer attribution

Product reporting is **not implemented**. Keep three outcomes separate: local viewer history, Plex activity visibility, and personal Plex resume/watched/history writes. The [reporting investigation](plex-reporting-investigation.md) owns empirical request shapes and remaining compatibility questions.

Future reporter requirements:

- Drive reports from accepted decoded viewer observations, not room time or encoder progress. Fence by verified subject, server/item, playback occurrence and current viewer/stream epochs.
- Separate operator activity reporting from personal-state consent. Serialize opt-out after dispatched writes settle and cancel queued stale writes. Never substitute full sync when activity-only behavior is unverified.
- Handle duplicate tabs, handoff, external-player conflicts, revocation and process loss without stale retries or retroactive attribution.
- Track sponsored viewers locally. Their source credential creates no personal Plex identity; never write owner history for guests. Verify source-account side effects before offering sponsored reporting.
- Resolve shared-producer stop behavior before pooling reports: a linked stopped timeline report terminated its HLS job in testing. External AV1 output declarations did not fix Plex's source-based classification.

## Guest passes

M2-P3 follows authorization/reporting foundations. Use hashed high-entropy room-scoped tokens, expiry/revocation, atomic use limits, attendance/concurrency ceilings, bounded reconnect and rate limits. Guest names are unverified.

Operator delegation must bound issuers and media scope independently from room permission presets. Passes cannot grant host/admin rights, permanent ownership or named host invitations. Revoke existing sockets and media/caption/artwork access. Registered-account conversion requires fresh provider proof and an explicit history/role policy.

## Next increments

1. Complete the configuration/admin contract and policy matrix.
2. Harden sensitive account changes, operator recovery and live revocation.
3. Resolve reporting lifecycle/compatibility, then implement personal reporting.
4. Add granular sponsorship and guest passes only after their authority/attribution decisions.

Use the [verification standard](testing.md#verification-standard-for-new-work); these plans do not authorize live history changes or deployment.
