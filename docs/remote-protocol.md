# Remote integration contract

The remote extension and uburoom use independently versioned builds. uburoom-remote owns the extension, builds, assets and tests. uburoom owns its server integration, shared command modules, web renderer and branding; its original extension directory and standalone remote homepage are removed. Neither checkout depends on the other's layout.

## Ownership

| Source or behavior | Owner |
| --- | --- |
| Room/playback command schema and server authorization | uburoom; the remote carries an explicitly versioned contract copy |
| Viewport/transform validation and calculations | Versioned copies in both repositories |
| YouTube TV integration, extension lifecycle, popup, origin configuration and extension packaging | Remote repository |
| Web remote drawer, web assets and server/source packaging | uburoom |
| Styles, icons and branding | Each repository owns its local copy and preserves applicable provenance/notices |
| Protocol fixtures and contract tests | Matching versioned copies, runnable without the other checkout |

uburoom's `shared/room-protocol.js` owns room/playback command validation. `shared/viewport.js` owns transform/profile validation and picture calculations without room timeline dependencies. `shared/engine.js` dispatches between them and retains text command parsing, player snapshot validation and seek calculations. uburoom-remote owns the corresponding modules under its local `extension/`. Existing web, Discord and extension callers still enter the validated engine. Command validation does not authorize an actor; uburoom continues to enforce access, consent, epochs and deadlines.

Copies must identify their contract revision and pass the same `tests/fixtures/remote-protocol-v1.json` cases using matching `tests/remote-protocol.test.js` copies. The test selects this package's local source directory; it never imports a sibling checkout. A shared wire/validation change requires coordinated fixture review and compatible releases. UI copies may evolve independently; they are not part of the wire contract. Firefox's fixed add-on identity is part of the sign-in contract; the server records it independently rather than reading the extension manifest, and the integration runner checks that the external manifest matches.

## Version negotiation

The initial contract is `{ "room": 1, "viewport": 1 }`. These are protocol revisions, independent of application and extension release numbers. Both revisions must match exactly. Breaking command, envelope, validation or lifecycle changes require incrementing the affected revision and updating its fixtures. Missing versions and private pre-release protocols are unsupported.

The extension opens `wss://<configured-origin>/ws` and sends:

```json
{ "type": "auth", "deviceId": "<UUID>", "credential": "<private device credential>", "protocol": { "room": 1, "viewport": 1 } }
```

After checking the revision and authenticating the device, the server replies:

```json
{ "type": "auth-ok", "protocol": { "room": 1, "viewport": 1 } }
```

An incompatible client is closed with code `4006`, before registering or replacing an authenticated device connection. The extension also checks the reply, rejects an unversioned or incompatible server, disables consent and reports that the extension and server need updating. It stops automatic reconnect attempts for this error, retains pairing and never downgrades. Reload the extension after updating to retry. Authentication failures remain `4003`; malformed messages remain `4002` and rate limits remain `4008`.

## Commands and lifecycle

- Device sign-in remains proof-bound and owner-authorized. Credentials stay in private extension storage and are never part of configured builds or URLs. Firefox uses the fixed identity return URL; Chromium support is future work.
- Only explicitly configured HTTPS origins are accepted. Builds retain narrow host permissions and matching HTTPS/WSS CSP entries. The split does not widen them.
- Canonical registration uses `type: 'room'` with `roomId`, a fresh `epoch`, current consent, reachability, sharing mode and control permissions. The server replies with `type: 'room-ack'`, matching `roomId`/`epoch`, server time and confirmed live state.
- Commands carry `roomId`, `epoch`, a unique command ID and a short expiry. The extension validates commands and current reachability, consent, actor, permissions, epoch and deadline before forwarding to the player; it rechecks lifecycle/expiry after awaiting execution. Acknowledgements are not proof of decoded playback.
- Disconnect, tab/browser/server restart and incompatible versions leave remote consent off. A remembered On join preference does not restore consent or replay old voice events. Existing fresh-join authorization remains required.
- `session.*`, `sessionId` and old room wire aliases are unsupported. Current authorization continues to hide inaccessible rooms and reject ambiguous targets, revoked access and stale commands.

## Compatibility and verification

| Extension contract | Server contract | Expected result |
| --- | --- | --- |
| Room 1 / Viewport 1 | Room 1 / Viewport 1 | Authenticate, then require current consent and authorization |
| Missing or different revision | Room 1 / Viewport 1 | Close `4006` before device registration/replacement |
| Room 1 / Viewport 1 | Missing or different revision | Extension closes `4006`, leaves consent off and stops automatic reconnects |

Chrome and Firefox are equal required test targets for the web client. The current extension build is Firefox-only; Chromium extension support is deferred to M2-P10. No Chromium extension compatibility is claimed by passing web tests. Actual results, the deferred full extension smoke failures and the remaining extraction/lifecycle checks belong in [testing status](archive/testing-2026-10-22.md#remote-extension-repository-separation).
