# Accounts, administration and Plex reporting

Current: YAML configuration, admission/password policies, verified server-operator authorization, the 19-key browser Server Settings panel (Rooms, Directory, Transcoding), configured sponsorship, Activity handoff, single-room operation, decoupled Plex reporting and [names/host assignments](account-names-and-host-directory.md) are implemented. P14's three outcomes have passed source review and isolated execution: authorization boundaries, account mutation/session safety, and configuration backup/restore. Real-provider integration remains a release gate. Room invites, guests (M2-P3) and the trusted tier are implemented; see [room invites and guests](#room-invites-and-guests).

## Authorization contract

| Layer | Authority |
| --- | --- |
| Identity | Canonical UUID plus verified provider subjects; names grant nothing |
| Sign-in | Configured Plex/Discord methods; both off allows anonymous guest visitors |
| Room invite | One code per room; reaches private rooms and admits guests where the room allows them; never a role, Admin mode or personal Plex access |
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

## Room invites and guests

Implemented M2-P3 contract (room store and `/api/watch/invite` in `server/watch-http.js`); real-provider and human acceptance remain open in [testing](testing.md). Configuration is in [self-hosting](self-hosting.md#room-invites-and-guests).

**Owner-approved 2026-11-07: trusted tier.** Server-wide tiers are operator, admins, trusted and members (`RoomPolicy.serverTier`). Trusted sits between admins and members, configured like the admin lists and matched only against verified identities. It grants no Admin mode, room rights, admission or Plex media entitlement. Its only current use is `guests.issuers`.

**Owner-approved 2026-11-08: one invite per room.** This replaces the 2026-11-07 multi-pass design.

- Every room has one invite code: two six-letter ubumfa words (`ubumfa-ogdave`), shared as `/join/<code>` or typed on the sign-in screen in any case, with or without a separator. Anyone in the room can share it. Hosts can reroll it.
- Someone the server already admits who uses the invite goes to the room. If the room is private, they are added to its invited list (`watch_room_invites`) and keep access until revoked. A reroll revokes nobody.
- **Allow guests** is per room, defaulting on for new rooms when `guests.default_allow` is true (default true). Turning it on or off needs `guests.enabled`, the `guests.issuers` tier and hosting the room (Admin mode always counts). While it is on, the invite also admits people the server would not: unverified guests with a typed name, or signed-in visitors from outside, up to `guests.max_per_room`. Guest access lasts `guests.session_hours` and is bound to the browser session (`login.guestRoom`), never to a role. Turning it off stops new guests; current guests stay.
- **Explicit revokes only.** Kicking a guest ends their guest access and blocks their account and browser marker (`uburoom_device`) from the invite. Kicking an invited member of a private room revokes their invite and blocks their account. Revoke in Room settings → People does the same for someone offline. Remove all guests ends every guest session in the room and rerolls the code. Blocks (`watch_room_invite_blocks`) end when the code is rerolled. All removals use the kick notice, then end the sign-in and close the socket.
- Guest sessions see only their room, can't create rooms or use Admin mode, can't change the invite and are viewers for every capability. Room records list current guests in `guests`, which the shared role check treats as viewers even under All hosts; host assignment refuses them. Private rooms admit leaders, hosts, invited members and current guests (`RoomPolicy.admitted`). Reopening a closed room stays with leaders, hosts and Admin mode, and a guest whose room is closed is told it isn't open.
- Guests replace guild membership, Plex server membership and the entry password, but never required personal Plex access; config validation requires `guests.require_sign_in` with `access.require_plex`.
- Guest names are unverified, use the ordinary name rules, and may not match the name of a signed-in person present in the room. Guest accounts (`users.guest = 1`) are excluded from host search, cannot link a provider (signing in starts a separate account and replaces the guest session), are never reported to Plex and watch only through configured sponsorship. Anonymous visitors (both sign-in methods off) are guest accounts too. Unused guest accounts and their local history are deleted after a minute.
- Invite attempts are rate-limited per address. Codes are low-secrecy join codes, comparable to a party game's room code, and may appear in request logs.

Registered-account conversion (keeping a guest's history after they sign in) is not implemented.

## Next increments

Complete real-provider admission/revocation/handoff and independent operator recovery under the release gates. Complete live verification for decoupled Plex reporting and real-provider invite and guest checks.

Use the [verification standard](testing.md#verification-standard-for-new-work); these plans do not authorize live history changes or deployment.
