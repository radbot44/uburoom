# Accounts, administration and Plex reporting

Current: YAML configuration, admission/password policies, verified server-operator authorization, the 19-key browser Server Settings panel (Rooms, Directory, Transcoding), configured sponsorship, Activity handoff, single-room operation, decoupled Plex reporting and [names/host assignments](account-names-and-host-directory.md) are implemented. P14's three outcomes have passed source review and isolated execution: authorization boundaries, account mutation/session safety, and configuration backup/restore. Real-provider integration remains a release gate. Guest passes (M2-P3) and the trusted tier are implemented; see [guest passes](#guest-passes).

## Authorization contract

| Layer | Authority |
| --- | --- |
| Identity | Canonical UUID plus verified provider subjects; names grant nothing |
| Sign-in | Configured Plex/Discord methods; both off allows anonymous guest visitors |
| Guest pass | A room-scoped, revocable link standing in for admission in one room; never a role, Admin mode or personal Plex access |
| Admission | Current provider/Plex/password rules and verified Activity context |
| Media | Current personal Plex entitlement or explicitly configured sponsorship |
| Room roles | Viewer, host, creator and explicit Admin override; none grants Plex entitlement |
| Server operator | Verified Discord or Plex subject explicitly selected in YAML; independent of room roles and media entitlement |
| Reporting | Actual verified Plex subject, independently of the source/encoder credential |

**Approved sharing policy:** Fallback is enabled by default for eligible viewers without an attached Plex account or with confirmed server nonmembership when personal access is not required. Removing a Plex link can therefore permit configured sponsorship. This is an explicit operator choice, not personal entitlement. Revoked/expired credentials, provider errors and item denials fail closed. Dedicated non-owner direct delegation is a separate opt-in. See [operator settings](self-hosting.md#shared-plex-fallback).

Provider-confirmed admission lasts five minutes between checks, so a removed viewer can stay up to that long. After that only the provider's own denial removes an admitted viewer; one that gives no answer is asked again every 30 seconds, for up to 12 hours since the last confirmation. Nobody new is admitted without an answer, and a linked-provider or Plex-requirement change starts over.

Recheck authority around awaited work across sockets, catalogs, artwork, captions, queues and media. Planned canonical deny/revocation rules must take precedence over alternate providers and passes. Finer-grained source/library/item/audience grants remain future work; do not describe them as implemented.

## Configuration and administration

Set `operator.discord_id` and/or `operator.plex_id` to exact quoted provider account IDs in private YAML, then restart. Either matching **verified** identity on the authenticated account grants server-operator authority; blank or omitted settings grant none. Names, manual pending assignments, `discord.owner_id`, room administrators/owners and the owner of `plex.token` grant no implicit operator authority. Operator status does not grant room permissions, admission or Plex media entitlement.

The reusable server check is `isServerOperator(registry, config, userId)` in `server/operator-policy.js`. Call it with the canonical UUID from a current authenticated server session and recheck after awaited work before an administration mutation. It reads current verified registry identities, so unlinking the configured identity removes that authority unless the other configured identity still matches. Existing owner Admin account matching retains its current authorization. The browser Account dialog uses the server-derived `serverOperator` capability to show **Server settings**, independently of Admin mode; Activity does not expose this entry.

`GET /api/operator/settings` uses the authenticated browser session and returns `401` without a valid session or `403` for a nonoperator. Its noncacheable response has `source: 'running'` and an allowlisted `settings` object covering access policy, room limits/default permissions, directory visibility and transcoding policy/quality choices. It reads the running configuration, not pending YAML edits. Credentials, passwords, provider/account IDs, endpoints and paths are excluded. Session validity and operator authority are rechecked after persistence waits. Playback admission/media entitlement remain independent; no restart/recovery controls are implemented.

Internal YAML persistence uses `createConfigEditor(selectedPath)` in `server/config-editor.js`; omitted paths use the existing `--config` selection. `read()` returns a file revision and nonsecret settings (`source: 'file'`); `readEditable()` limits this to editable dotted YAML keys. `save({revision, changes})` accepts only the existing allowlist for room capacity/default permissions, directory visibility and transcoding. Access policy, single-room mode, retention/history deletion, identities, credentials, connections and paths are excluded. The complete file is validated relative to its directory; YAML comments and unrelated values are retained, though formatting and replaced-list comment placement can change. Saving leaves running settings unchanged and requires a later explicit restart.

`GET /api/operator/settings/saved` returns saved editable settings (including defaults) and their file revision. `POST` to the same endpoint accepts `{revision, changes}` using the current operator session and existing origin/CSRF protection, with no additional authentication flow. The startup-selected path is fixed server-side; client paths are rejected. Stale revisions return `409 CONFIG_CONFLICT`. Authorization is rechecked after queueing and immediately before replacement. Success returns `{ok: true, restartRequired: true}`, without restarting or exposing backup paths. The audit event records the canonical actor UUID and submitted setting names only. YAML replacement and audit persistence are separate: a crash can leave a missing audit event; audit failure after saving returns `503` with `saved: true` and `restartRequired: true` rather than claiming the file was unchanged.

The browser panel groups editable fields into Rooms, Directory and Transcoding. Save submits changed fields only; Cancel discards the draft, while Escape/backdrop preserve unsaved edits. On conflict, Review latest retains the draft and requires an explicit saved/draft choice for overlapping fields. A saved-but-audit-unconfirmed response is shown as saved with a warning. Settings require a later manual restart; the panel does not restart uburoom.

Saves are serialized within the process, retain a verified backup in a protected `.uburoom-config-*/original.yaml` directory beside the selected file, and verify staged bytes before same-filesystem rename. Windows preserves owner/group/access rules with inheritance frozen; Unix preserves ownership and tightens access to the owner's prior read/write bits. Linked configuration files are refused. Errors omit source contents/paths. Content, metadata and Windows access rules are rechecked before replacement, but an external editor can still race the final check/rename; this is not a cross-process lock or a power-loss durability guarantee. Unsupported replacement fails without a delete/copy fallback. Protected backups may remain after a failed save or interrupted process; treat them as secret-bearing files. Restoring YAML cannot restore already-deleted application data.

M1 administration boundary:

- Private `config.yaml` remains the sole configuration authority. The 19-key allowlist in `server/config-editor.js` (Rooms, Directory and Transcoding) is the complete M1 browser-editable scope; access policy, single-room mode, retention/history deletion, operator IDs, credentials, connections and paths remain YAML-only.
- Saving never exposes secret-bearing YAML content, creates competing stores, implicitly restarts services or alters provider registration.
- Operators can edit the supported settings with complete-file validation and revision conflict rejection. Room Admin mode is not global configuration authority.
- Ordinary viewers cannot administer the server; creators, explicit hosts, All hosts and room Admin mode grant no Plex entitlement. Detected provider/item denial rejects existing media/caption grants, including subtitle windows, without owner-token fallback. Provider checks cache for up to 30 seconds and item checks for 3 seconds; active proxy streams recheck every 2 seconds (subtitle resources every 1 second). Already-issued direct Plex URLs remain subject to PMS enforcement.

## Account linking and unlinking safety

Provider removal requires another verified, enabled, currently eligible sign-in method; Plex also requires a stored credential. A configured operator identity does not enable a disabled provider. The configured Discord owner can retain Discord through the existing owner-only sign-in when ordinary Discord is disabled; removal still checks current Discord eligibility.

Link/reconnect, unlink, merge and assignment advance account revisions and invalidate previous browser sessions, Activity bearer tokens and media/caption grants for affected accounts. Active viewers are removed and their sockets closed. Successful self-service mutations issue a replacement browser session; Activity must authenticate again. Logout affects only the selected browser session and its viewers, preserving provider links and independently authenticated sessions. Merge and assignment require the affected accounts to leave active rooms and recheck current login, authority, revisions and participation after awaited work.

Callback and preview proofs expire, bind to their originating browser/account and reject replay, conflicts and stale revisions. Manual provider assignments are not verified identities. Existing name search and pending host assignments are described in their [own contract](account-names-and-host-directory.md); do not reimplement them.

## Backup, restore and rollback

Use the [matched backup procedure](upgrading.md#retaining-state): stop and flush the installation before copying, or take a consistent SQLite online snapshot. Copy the matching private YAML and exact original 32-byte credential key, preserving restricted access and any separately stored TLS material. Do not copy a changing database as an ordinary file. Coordinate configuration/key changes so the snapshot and files belong together.

Restore into a clean directory with the selected compatible code and correct configured paths; check SQLite integrity, canonical UUIDs, verified identities, credential decryption, durable rooms/queues and saved settings before use. Missing keys prevent startup; mismatched keys fail authenticated decryption and are never replaced automatically. Rollback across state changes requires the matched database/config/key set, not code alone, and discards changes made after the snapshot. Isolated coverage includes an online SQLite snapshot with stable YAML/key files and restore of pre-change state; independent operator recovery remains a release gate.

## Discord Activity and browser handoff

Preserve one-use expiring handoff authorization, source-grant/browser binding and confirmation for an existing browser-account mismatch. Carry the same account and current policy into the browser. The Activity exception to required Plex access never exempts browser entry; Activity-only installations permit browser account management, not browser playback.

Further Plex-only/Activity association work must bind fresh Plex proof to the exact pending attempt and distinguish temporary context from permanent linking. Discord context alone cannot silently enroll a login, enable a disabled provider or grant media access. Verify real SDK/proxy behavior separately from fixtures.

## Plex activity and viewer attribution

Product reporting architecture is implemented on `main` (`server/plex-reporting.js`) with decoupled session identity. Keep three outcomes separate: local viewer history, Plex activity visibility, and personal Plex resume/watched/history writes. The [reporting investigation](plex-reporting-investigation.md) owns empirical request shapes and baseline compatibility notes.

Reporter guarantees:

- Decouple viewer timeline reporting sessions (`viewerSessionId`) from shared transcode jobs (`transcodeId`). PMS Universal Transcoder couples a transcode job 1:1 to a `StreamingResourceSession`; sending `state=stopped` with that transcode's ID kills the transcoder and deletes temporary segments for all viewers. Decoupling ensures one viewer leaving never interrupts active room playback.
- One reporting occurrence belongs to the same viewer/tab, room, verified Plex subject/server and version-qualified video occurrence. Quality/track/delivery changes and fresh observation epochs reattach to that identity. An eligible reconnect through the same tab's saved grace record can replace the viewer object without replacing its reporting identity. Different tabs, explicit leave/rejoin and a new video occurrence remain distinct.
- Recovery is bounded by the existing 60-second reconnect grace (the saved reconnect record supplies its actual expiry). Suspended reporting sends only `buffering` at the last accepted viewer position, at most every ten seconds after the suspension transition, with `duration` omitted even when personal sync is enabled. It never extrapolates playback or credits the gap. A fresh accepted observation resumes ordinary consent-scoped reporting; expiry, opt-out, completion, logout/account change, access loss or room closure ends continuity. Suspended viewers are included in cleanup. This keeps request identity stable; real PMS/Tautulli retention across the full grace remains unverified.
- Drive reports from accepted decoded viewer observations, not room time or encoder progress. Fence by verified subject, server/item, playback occurrence and current viewer/stream epochs.
- Check current login authority independently of a control socket's liveness, plus room/media eligibility and personal Plex credentials. A closed socket alone does not revoke bounded reporting continuity. Queued reports carry their attachment generation; stale authorization results cannot end a newer attachment. Terminal dispatch settles before a replacement occurrence starts. Authorization loss never falls back to source/owner credentials.
- Separate operator activity reporting from personal-state consent. Users with connected Plex accounts default to activity-only reporting (`duration` is omitted from `/:/timeline` queries), keeping playback visible in Now Playing without mutating personal view offsets or play history. Personal watch-state synchronization requires explicit opt-in.
- Handle duplicate tabs, handoff, external-player conflicts, revocation and process loss without stale retries or retroactive attribution.
- Track sponsored viewers locally. Their source credential creates no personal Plex identity; never report or write owner history for guests without personal Plex accounts.

## Guest passes

Implemented M2-P3 contract (`server/guest-passes.js`); real-provider and human acceptance remain open in [testing](testing.md). Configuration is described in [self-hosting](self-hosting.md#guest-passes).

**Owner-approved 2026-11-07: trusted tier.** Server-wide tiers are operator, admins, trusted and members (`RoomPolicy.serverTier`). Trusted sits between admins and members and is configured like the admin lists: exact Discord/Plex account IDs and Discord guild role IDs, matched only against verified identities. It grants no Admin mode, room rights, admission or Plex media entitlement. Guest-pass issuing is its only current use. `guests.issuers` names the lowest tier allowed to issue passes; higher tiers are included and the operator always qualifies.

**Owner-approved 2026-11-07: issuing checks.** Issuing also requires the room-level `inviteGuests` permission in the pass's room. It is a host permission, off for hosts by default, never grantable to viewers, and Admin mode includes it. A pass stops working, and its guests are removed, once its issuer no longer meets `guests.issuers` or loses `inviteGuests` in that room (for an existing pass, Admin eligibility counts, so leaving Admin mode does not end it). Issuer standing is checked at creation, on every entry and by the one-second sweep. A Discord role check without a current guild answer counts as unknown: guests stay, nobody new is admitted and the guild is asked again.

**Owner-approved 2026-11-07: off versus revoked.** Turning a pass off stops new entries and can be undone; guests already in stay. Revoking is permanent and removes its guests at once. Expiry acts like revocation.

- Tokens are 32 random bytes in the link fragment (`/join#…`), so they stay out of request logs. Only a SHA-256 hash is stored, so a link can be shown only when made. Uses are counted atomically; a pass can't exceed `max_uses`, and a room can't exceed `max_per_room` guests. Entry attempts are rate-limited per address.
- A pass binds to a browser session (`login.pass = {id, roomId}`), never to an account. Without sign-in, uburoom creates a guest account (`users.guest = 1`) whose session ends with the pass. A signed-in visitor who already meets the normal rules is sent straight in without using the pass; one who doesn't has the pass bound to their existing session. Sign-in passes refuse guest accounts. Passes are browser-only and never cover a Discord Activity.
- A pass session's actor carries `pass` and `passRoomId`. It sees and joins only that room, can't create rooms, issue passes or enter Admin mode, and is evaluated as a viewer for every room capability. Room records list current pass holders in `guests`, which the shared role check treats as viewers even under All hosts; host assignment refuses them.
- A pass replaces guild membership, Plex server membership and the entry password, but never required personal Plex access: under `access.require_plex` the ordinary Plex check still applies and config validation requires `guests.require_sign_in`.
- Guest names are unverified, use the ordinary name rules, and may not match (case-insensitively) the name of a signed-in person present in the room. Guest accounts are excluded from host search, cannot link a provider (signing in starts a separate account and replaces the guest session) and have no Plex identity, so they are never reported to Plex and watch only through configured sponsorship. Anonymous visitors (both sign-in methods off) are guest accounts too.
- Ending a pass deletes guest sessions, strips the binding from signed-in sessions, removes their viewers and closes their sockets (`watchRoutes.invalidate`). Unused guest accounts and their local history are deleted after a minute; passes ended for over a day are pruned.

Registered-account conversion (keeping a guest's history after they sign in) is not implemented and needs fresh provider proof and an explicit history/role policy.

## Next increments

Complete real-provider admission/revocation/handoff and independent operator recovery under the release gates. Complete live verification for decoupled Plex reporting and real-provider guest pass checks.

Use the [verification standard](testing.md#verification-standard-for-new-work); these plans do not authorize live history changes or deployment.
