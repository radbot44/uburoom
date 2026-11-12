# Accounts, access and Plex reporting

Uburoom's account, administration, and access architecture enforces layered authorization across identity, admission, room roles, server operations, and Plex reporting. It combines external Discord and Plex authentication with canonical account UUIDs, unified browser sessions, invite codes with guest admission, and decoupled Plex activity tracking.

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

**Approved sharing policy:** Fallback is enabled by default for eligible viewers without an attached Plex account or with confirmed server nonmembership when personal access is not required. Removing a Plex link can therefore permit configured sponsorship. This is an explicit operator choice, not personal entitlement. Revoked/expired credentials, provider errors and item denials fail closed. Dedicated non-owner direct delegation is a separate opt-in; see [operator settings](self-hosting.md#shared-plex-fallback).

Provider-confirmed admission lasts five minutes between checks, so a removed viewer can stay up to that long. After that only the provider's own denial removes an admitted viewer; one that gives no answer is asked again every 30 seconds, for up to 12 hours since the last confirmation. Nobody new is admitted without an answer, and a linked-provider or Plex-requirement change starts over.

Recheck authority around awaited work across sockets, catalogs, artwork, captions, queues and media. Planned canonical deny/revocation rules must take precedence over alternate providers and passes. Finer-grained source/library/item/audience grants remain future work; do not describe them as implemented.

## Accounts, names and identity

- One canonical UUID per account, seeded at first sign-in. Provider refresh, linking, or unlinking preserves the UUID; verified account merging keeps the surviving account's display name. Cosmetic rename operations do not invalidate sessions or sign users out.
- Display names are normalized, trimmed plain text, 1–80 Unicode characters (NFC), without control or invisible characters (`/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u`). Duplicate names are allowed; directory search and member listings append a short account discriminator (`· Account ` + `userId.slice(0, 8)`) when names collide. Names and email addresses never prove identity or grant authority.
- Discovery creates no accounts. `signedInAt: null` indicates an account that has never authenticated (such as a pending assigned placeholder); `0` indicates a known account from historical records with an unknown sign-in timestamp. Placeholders are never treated as authenticated users.
- Authentication relies on configured external providers (Discord and Plex); native username/password logins and owner name-lock rules remain deferred.

## Provider directory and member search

`directory.expose_discord_members: true` and `directory.expose_plex_members: false` are the defaults. Previously authenticated users remain searchable locally even when external provider discovery is disabled. Discovery never grants sign-in, room entry, or media access.

| Provider | Boundary |
| --- | --- |
| Discord | Configured guild only; exclude bots and bound pagination. Request optional member/presence intents only when application flags permit; missing capabilities warn without disabling ordinary operations. Read presence only from a ready shard. |
| Plex | Configured owner token and pinned server's accepted library shares only. Exclude managed profiles, pending invitations, other servers, emails and shared-user tokens. Bound responses to 4 MiB; reject external XML entities. Unsupported privilege or payload shape reports unavailable. |

Search debounce is 250 ms in the client; shared provider success cache is 60 seconds and failure backoff is 15 seconds. Provider failure leaves local account search available with an informative notice.

Room-scoped search (`/api/watch/rooms/:id/people`) checks authority before and after provider work, rate-limits requests (120 per minute), and returns at most 20 results. Mutations check current room revisions (rejecting stale edits with 409). Search never exposes credentials, emails, full provider profiles, or the owner account endpoint.

Results are deduplicated by canonical UUID and ranked across four priority groups:
1. Present in this room.
2. Connected elsewhere in uburoom (including the lobby).
3. Previously signed-in accounts.
4. External provider members who have never signed in.

Within groups 3 and 4, positively observed Discord presence ranks first, followed by alphabetical name order. Unknown presence is not treated as offline; Plex presence is not queried. Authenticated sockets are deduplicated by canonical UUID, separately from reconnect reservations.

### Pending host assignments

Known accounts receive immediate UUID assignments in `watch_room_hosts`. Other targets receive durable exact provider/subject grants in `watch_room_host_grants` with provider, subject ID, display name, issuer UUID, and timestamp. When that individual subsequently signs in and authenticates with a verified provider identity matching the grant, `claimHosts(userId)` atomically promotes the grant to full host status in `watch_room_hosts` and removes the pending grant row. Disabling directory discovery does not hide or revoke pending grants.

## Configuration and administration

Set `operator.discord_id` and/or `operator.plex_id` to exact quoted provider account IDs in private YAML, then restart. Either matching **verified** identity on the authenticated account grants server-operator authority; blank or omitted settings grant none. Names, manual pending assignments, `discord.owner_id`, room administrators/owners and the owner of `plex.token` grant no implicit operator authority. Operator status does not grant room permissions, admission or Plex media entitlement.

The reusable server check is `isServerOperator(registry, config, userId)` in `server/operator-policy.js`. Call it with the canonical UUID from a current authenticated server session and recheck after awaited work before an administration mutation. It reads current verified registry identities, so unlinking the configured identity removes that authority unless the other configured identity still matches. Existing owner Admin account matching retains its current authorization. The browser Account dialog uses the server-derived `serverOperator` capability to show **Server settings**, independently of Admin mode; Activity does not expose this entry.

`GET /api/operator/settings` uses the authenticated browser session and returns `401` without a valid session or `403` for a nonoperator. Its noncacheable response has `source: 'running'` and an allowlisted `settings` object covering access policy, room limits/default permissions, directory visibility and transcoding policy/quality choices. It reads the running configuration, not pending YAML edits. Credentials, passwords, provider/account IDs, endpoints and paths are excluded. Session validity and operator authority are rechecked after persistence waits. Playback admission/media entitlement remain independent; no restart/recovery controls are implemented.

Internal YAML persistence uses `createConfigEditor(selectedPath)` in `server/config-editor.js`; omitted paths use the existing `--config` selection. `read()` returns a file revision and nonsecret settings (`source: 'file'`); `readEditable()` limits this to editable dotted YAML keys. `save({revision, changes})` accepts only the existing allowlist for room capacity/default permissions, directory visibility and transcoding. Access policy, single-room mode, retention/history deletion, identities, credentials, connections and paths are excluded. The complete file is validated relative to its directory; YAML comments and unrelated values are retained, though formatting and replaced-list comment placement can change. Saving leaves running settings unchanged and requires a later explicit restart.

`GET /api/operator/settings/saved` returns saved editable settings (including defaults) and their file revision. `POST` to the same endpoint accepts `{revision, changes}` using the current operator session and existing origin/CSRF protection, with no additional authentication flow. The startup-selected path is fixed server-side; client paths are rejected. Stale revisions return `409 CONFIG_CONFLICT`. Authorization is rechecked after queueing and immediately before replacement. Success returns `{ok: true, restartRequired: true}`, without restarting or exposing backup paths. The audit event records the canonical actor UUID and submitted setting names only. YAML replacement and audit persistence are separate: a crash can leave a missing audit event; audit failure after saving returns `503` with `saved: true` and `restartRequired: true` rather than claiming the file was unchanged.

The browser panel groups editable fields into Rooms, Directory and Transcoding. Save submits changed fields only; Cancel discards the draft, while Escape/backdrop preserve unsaved edits. On conflict, Review latest retains the draft and requires an explicit saved/draft choice for overlapping fields. A saved-but-audit-unconfirmed response is shown as saved with a warning. Settings require a later manual restart; the panel does not restart uburoom.

Saves are serialized within the process, retain a verified backup in a protected `.uburoom-config-*/original.yaml` directory beside the selected file, and verify staged bytes before same-filesystem rename. Windows preserves owner/group/access rules with inheritance frozen; Unix preserves ownership and tightens access to the owner's prior read/write bits. Linked configuration files are refused. Errors omit source contents/paths. Content, metadata and Windows access rules are rechecked before replacement, but an external editor can still race the final check/rename; this is not a cross-process lock or a power-loss durability guarantee. Unsupported replacement fails without a delete/copy fallback. Protected backups may remain after a failed save or interrupted process; treat them as secret-bearing files. Restoring YAML cannot restore already-deleted application data.

### Administration boundaries and configuration safety

- Private `config.yaml` remains the sole configuration authority. The 19-key allowlist in `server/config-editor.js` (Rooms, Directory and Transcoding) is the complete browser-editable scope; access policy, single-room mode, retention/history deletion, operator IDs, credentials, connections and paths remain YAML-only.
- Saving never exposes secret-bearing YAML content, creates competing stores, implicitly restarts services or alters provider registration.
- Operators can edit the supported settings with complete-file validation and revision conflict rejection. Room Admin mode is not global configuration authority.
- Ordinary viewers cannot administer the server; creators, explicit hosts, All hosts and room Admin mode grant no Plex entitlement. Detected provider/item denial rejects existing media/caption grants, including subtitle windows, without owner-token fallback. Provider checks cache for up to 30 seconds and item checks for 3 seconds; active proxy streams recheck every 2 seconds (subtitle resources every 1 second). Already-issued direct Plex URLs remain subject to PMS enforcement.

## Account linking and unlinking safety

Provider removal requires another verified, enabled, currently eligible sign-in method; Plex also requires a stored credential. A configured operator identity does not enable a disabled provider. The configured Discord owner can retain Discord through the existing owner-only sign-in when ordinary Discord is disabled; removal still checks current Discord eligibility.

Link/reconnect, unlink, merge and assignment advance account revisions and invalidate previous browser sessions, Activity bearer tokens and media/caption grants for affected accounts. Active viewers are removed and their sockets closed. Successful self-service mutations issue a replacement browser session; Activity must authenticate again. Logout affects only the selected browser session and its viewers, preserving provider links and independently authenticated sessions. Merge and assignment require the affected accounts to leave active rooms and recheck current login, authority, revisions and participation after awaited work.

Callback and preview proofs expire, bind to their originating browser/account and reject replay, conflicts and stale revisions. Manual provider assignments are not verified identities.

## Backup and state retention

Operational backup and restoration procedures are defined in [retaining state](upgrading.md#retaining-state). To ensure state continuity across updates and migrations:
- Stop and flush the installation or take a consistent SQLite online snapshot before copying.
- Copy the matching private configuration file and exact original 32-byte credential key, preserving file permissions and any separately stored TLS material. Never copy a live SQLite database as an ordinary file while writes are pending.
- Restore into a clean directory with compatible code and verified paths. Missing keys prevent startup; mismatched keys fail authenticated decryption and are never replaced automatically. Rollback across state changes requires the matched database, configuration, and credential key set, discarding any state changes made after the snapshot.

## Discord Activity and browser handoff

Preserve one-use expiring handoff authorization, source-grant/browser binding and confirmation for an existing browser-account mismatch. Carry the same account and current policy into the browser. The Activity exception to required Plex access never exempts browser entry; Activity-only installations permit browser account management, not browser playback.

Further Plex-only/Activity association work must bind fresh Plex proof to the exact pending attempt and distinguish temporary context from permanent linking. Discord context alone cannot silently enroll a login, enable a disabled provider or grant media access.

## Plex activity and viewer attribution

Product reporting architecture in `server/plex-reporting.js` decouples local viewer history, Plex activity visibility, and personal Plex resume/watched/history writes.

### Reporting identifier mapping

| Identifier | Purpose |
| --- | --- |
| Verified Plex token/subject | Personal reporting authority |
| Source/producer credential | Entitlement for upstream bytes; may differ from consumer |
| `X-Plex-Client-Identifier` | Actual viewer client |
| `X-Plex-Session-Identifier` | Playback occurrence, consistent across decision/start/timeline |
| Transcode session parameter | Encoder job; distinct from client and occurrence |
| uburoom UUID/viewer/stream epochs | Local identity, observations and stale-work fencing |

### Reporter guarantees

- Decouple viewer timeline reporting sessions (`viewerSessionId`) from shared transcode jobs (`transcodeId`). PMS Universal Transcoder couples a transcode job 1:1 to a `StreamingResourceSession`; sending `state=stopped` with that transcode's ID kills the transcoder and deletes temporary segments for all viewers. Decoupling ensures one viewer leaving never interrupts active room playback.
- One reporting occurrence belongs to the same viewer/tab, room, verified Plex subject/server and version-qualified video occurrence. Quality/track/delivery changes and fresh observation epochs reattach to that identity. An eligible reconnect through the same tab's saved grace record can replace the viewer object without replacing its reporting identity. Different tabs, explicit leave/rejoin and a new video occurrence remain distinct.
- Recovery is bounded by the existing 60-second reconnect grace (the saved reconnect record supplies its actual expiry). Suspended reporting sends only `buffering` at the last accepted viewer position, at most every ten seconds after the suspension transition, with `duration` omitted even when personal sync is enabled. It never extrapolates playback or credits the gap. A fresh accepted observation resumes ordinary consent-scoped reporting; expiry, opt-out, completion, logout/account change, access loss or room closure ends continuity. Suspended viewers are included in cleanup.
- Drive reports from accepted decoded viewer observations, not room time or encoder progress. Fence by verified subject, server/item, playback occurrence and current viewer/stream epochs.
- Check current login authority independently of a control socket's liveness, plus room/media eligibility and personal Plex credentials. A closed socket alone does not revoke bounded reporting continuity. Queued reports carry their attachment generation; stale authorization results cannot end a newer attachment. Terminal dispatch settles before a replacement occurrence starts. Authorization loss never falls back to source/owner credentials.
- **Activity-only reporting and duration omission:** Users with connected Plex accounts default to activity-only reporting (`duration` is omitted from `/:/timeline` queries), keeping playback visible in Now Playing without mutating personal view offsets or play history. Personal watch-state synchronization requires explicit opt-in.
- **Address forwarding risk and deferred status:** Address forwarding (`X-Forwarded-For`) remains deferred. If PMS uses a forwarded viewer address as its remote address, uburoom viewers can be reclassified by PMS as remote streams, subjecting them to remote bandwidth budgets, per-user stream limits, and transcoding ceilings. Because shared playback relies on coordinated delivery, forwarding viewer IPs carries operational risk of PMS throttling or stream denial.
- Track sponsored viewers locally. Their source credential creates no personal Plex identity; never report or write owner history for guests without personal Plex accounts.

## Room invites and guests

Configuration options for invites and guests are in [self-hosting](self-hosting.md#room-invites-and-guests).

### Server tiers and trusted members

Server-wide standing is organized into four tiers: operator > admins > trusted > members (`RoomPolicy.serverTier`). The trusted tier sits between admins and members, configured via `rooms.trusted_discord_ids`, `rooms.trusted_plex_ids`, and `rooms.trusted_discord_role_ids`. It matches only verified provider identities and grants no Admin mode, room rights, server admission, or Plex media entitlement; its designated function is qualifying users to allow guests under `guests.issuers`.

### Room invite architecture

Every room has exactly one active invite code: two six-letter ubumfa words separated by a hyphen (e.g. `ubumfa-ogdave`), shared as `/join/<code>` links or typed manually on the sign-in screen in any case, with or without a separator. Anyone in the room can share the invite link; room hosts and administrators can reroll the code at any time.

- Someone the server already admits who uses the invite enters the room. If the room is private, they are added to its invited list (`watch_room_invites`) and retain access until revoked. A reroll revokes nobody.
- **Allow guests** is configured per room, defaulting on for new rooms when `guests.default_allow` is true (default true). Turning it on or off requires `guests.enabled`, the `guests.issuers` tier, and hosting the room (Admin mode always counts). While enabled, the invite admits people the server would not otherwise admit: unverified guests with a typed name, or signed-in visitors from outside, up to `guests.max_per_room`. Guest access lasts `guests.session_hours` and is bound to the browser session (`login.guestRoom`), never to a room role. Turning it off prevents new guests; current guests remain.
- **Explicit revocations and blocks:**
  - Kicking a guest terminates their guest session immediately (`endGuestSessions`) and blocks both their account and browser marker (`uburoom_device`) from the invite via `watch_room_invite_blocks`.
  - Kicking an invited member of a private room revokes their invite (`DELETE FROM watch_room_invites`) and blocks their account in `watch_room_invite_blocks`.
  - Revoking via Room settings → Viewers applies the same revocation and block for an offline user.
  - Remove all guests terminates every guest session in the room and rerolls the invite code.
  - Blocks in `watch_room_invite_blocks` expire when the room invite code is rerolled. All removals emit the kick notice, terminate the session, and close the socket.
- **Guest session boundaries:** Guest sessions see only their assigned room, cannot create rooms or enter Admin mode, cannot modify the invite, and are treated as viewers for every capability. Room records list current guests in `guests`, which the shared role check treats as viewers even under All hosts; host assignment rejects them. Private rooms admit leaders, hosts, invited members, and current guests (`RoomPolicy.admitted`). Reopening a closed room remains restricted to leaders, assigned hosts, and administrators; a guest whose room is closed is notified that it is unavailable.
- Guests replace guild membership, Plex server membership, and the entry password, but never required personal Plex access; configuration validation requires `guests.require_sign_in` when `access.require_plex` is enabled.
- Guest names are unverified, adhere to ordinary display name rules (1–80 characters, NFC), and cannot collide with the name of a signed-in person present in the room. Guest accounts (`users.guest = 1`) are excluded from host directory search, cannot link a provider (signing in starts a separate account and replaces the guest session), are never reported to Plex, and watch only through configured sponsorship. Anonymous visitors (when both sign-in methods are off) are also guest accounts. Unused guest accounts and their local history are deleted after one minute of disuse.
- Invite attempts are rate-limited per IP address. Codes are low-secrecy join codes, comparable to a party game's room code, and may appear in request logs. Registered-account conversion (retaining guest history after signing in) is not implemented.
