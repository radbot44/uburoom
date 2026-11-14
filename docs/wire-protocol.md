# Room connection protocol

A client holds one WebSocket to `/watch-socket` per tab or app window. Everything about rooms travels on it as JSON messages with a `type`. The message shapes and their validators live in [`shared/wire-protocol.mjs`](../shared/wire-protocol.mjs); the server, the browser and the test harnesses load that file, and other clients (such as `plezy-uburoom`) mirror it.

Protocol version: **2**. Version 1 was the earlier path-shaped protocol and is no longer spoken.

## Connecting

1. Open `wss://<origin>/watch-socket` with `Origin: <server.public_url>`. A browser's sign-in cookie rides on the upgrade.
2. Send `hello` within five seconds:

   ```json
   { "type": "hello", "protocol": 2, "token": "<64 hex, for bearer sign-in>", "csrf": "<for cookie sign-in>" }
   ```

3. The server answers `welcome`:

   ```json
   { "type": "welcome", "protocol": 2, "connectionId": 7, "resyncMs": 20000 }
   ```

A client that states another version, or sends anything other than `hello` first, gets `{ "type": "error", "code": "protocol", "status": 426, "message": "…", "supported": [2] }` and the socket closes with code 4010. Show the message and stop reconnecting: only updating the client helps.

Sending `hello` again on an open connection renews its sign-in (for example with a renewed bearer token).

Close codes: 4002 malformed message, 4003 sign-in missing, failed or revoked, 4008 too many messages, 4009 answer too large, 4010 protocol mismatch, 4029 server full.

## Requests

A request carries an `id` the client chooses (a non-negative integer, unique among its requests in flight; at most eight in flight). The server answers each with exactly one of:

```json
{ "type": "ack", "id": 12, "value": { } }
{ "type": "error", "id": 12, "code": "refused", "status": 409, "message": "Room changed or command expired; retry manually" }
```

`status` follows HTTP meanings (400 invalid, 403 not allowed, 404 unknown, 409 conflict or stale, 429 too many, 503 unavailable). `code` is `refused` for a refusal by the server's rules and `invalid` for a malformed request. A refusal with `"reconnect": "plex"` means the person's own Plex sign-in has expired, was revoked (a Plex password change signs out every device) or is missing; offer to sign in to Plex again rather than retrying. A request may carry `timeoutMs`; `{ "type": "cancel", "id": 12 }` abandons one. Requests are never replayed: after a reconnect, read state before retrying a change.

| Type | Fields | Answer |
| --- | --- | --- |
| `join` | `roomId`, `viewerId`, optional `preferences` | Both lanes of the tab's view (below), `timing` |
| `leave` | `roomId`, `viewerId` | `{ ok: true }` |
| `command` | `roomId`, `viewerId?`, `epoch`, `expiresAt`, `command: { action, args? }` | The command's outcome: `{ status: "applied" \| …, message? }` |
| `ready` | `roomId`, `viewerId`, `mediaVersion`, `ready`, `readinessVersion` | `{ ok: true }` |
| `observe` | `roomId`, `viewerId`, `observation: { … }` | The credit the observation earned |
| `call` | `op`, `roomId?`, `args?` | Depends on `op` |
| `resync` | none | `{ serverNow }`, after the lanes were sent again |

`viewerId` is a UUID the client makes for its tab and keeps across reconnects. `join` is the only way into a room: it admits the tab, or renews the tab that is already in. After a reconnect a client joins again with the same `viewerId`.

`preferences` (all optional): `quality`, `delivery` (`auto` or `local`), `subtitles` (`browser`), `codecs`, `volume`, `muted`, `plexReporting`, `plexWatchState`, `subtitlePreference`, `subtitleMode`, `audioPreference`.

A `command` is a room command from the shared command table ([`shared/room-protocol.mjs`](../shared/room-protocol.mjs)), fenced by the room `epoch` the sender last saw and an `expiresAt` in server time.

`call` covers what is neither a room command nor room state. `op` is one of the names in `CALLS`: `me`, `profile.rename`, `admin.mode`, `library.browse`, `library.item`, `library.availability`, `library.filters`, `playback.history`, `rooms.list`, `rooms.saved`, `rooms.create`, `events.list`, `events.schedule`, and for one room (`roomId` required) `room.reopen`, `room.close`, `room.people`, `room.settings`, `room.settings.edit`, `room.events`, `room.events.command`, `room.share`, `room.share.command`, `room.queue`, `room.queue.command`, `room.history`, `room.history.command`, `room.check`, `room.delivery`.

Two messages have no answer of their own: `clock` (the server replies with a `clock` message carrying the same `id`, `serverNow` and `timing`) and `quality` (a tab's sync-quality report).

## State: three lanes, pushed on change

The server sends state without being asked, and only when it changed.

| Message | Carries | Sent when |
| --- | --- | --- |
| `room` | `roomId`, `viewerId`, `version`, `state`: the room as this tab may see it (timeline, media, queue summary, participants, permissions) | The room changed |
| `viewer` | `roomId`, `viewerId`, `version`, `state`: this tab's own stream, tracks and settings, with `mediaVersion` | This tab's stream or settings changed, or the room's video did |
| `lobby` | `version`, `identity`, `rooms` | The room list or the person's standing changed |

A tab's view is its two lanes together: `mergeView(room.state, viewer.state)`. The `viewer` lane names the `mediaVersion` its stream belongs to; show the lanes together only when both name the same one (`lanesAgree`), so a new video is never paired with the previous video's stream. A lane message replaces that lane whole. Drop one whose `version` is lower than the lane's current version.

For people who may change the room's settings, the room state also carries `syncSpread` once a video has a minute of samples: `p50Ms`, `p95Ms`, `within50Percent`, `within100Percent`, `samples`, `sampleIntervalMs` and `players` (how many players the latest sample compared). It is the spread between the players' own reported offsets ([sync core](sync-core.md#sharedsyncqualitymjs)), so it leaves out screen and speaker delay. It is never pushed on its own: a new figure goes out with the room's next publication (sync reports republish the room at most every 10 s), so an idle room stays silent.

Position is never pushed as time passes: a client derives it from the timeline (`startAt`, `pauseAt`, `state.position`, `serverNow`) and its clock exchanges.

Every `resyncMs` the server sends each lane again, changed or not, as a safety net. A client can ask for the same with `resync`.

## Refusals about a room

Errors without an `id` are about the connection or a room:

| `code` | Meaning | What a client does |
| --- | --- | --- |
| `room` | The joined room's state is refused for this tab (`roomId`, `status`, `message`). With `rejoin: true` the room let the tab go (it went private, or the tab went silent). | Stop showing the room. With `rejoin`, offer to join again; the server does not let the tab back in by itself. |
| `removed` | A host removed the person from `roomId`. | Leave the room; make a new `viewerId` before joining again. |
| `unavailable` | The server could not publish just now. | Treat as a brief connection problem. |
| `auth` | Sign-in ended; the socket closes with 4003. | Sign in again. |
| `full` | The server is at its people limit; the socket closes with 4029. | Try later. |
| `protocol` | Version mismatch (see Connecting). | Update the client. |

## Limits

One message is at most 8 KiB from a client; a client may send 40 messages a second. The number of open connections is `server.max_connections` (default 256). A connection that sends nothing and answers no ping for ten seconds is closed.
