# Media sources and admission: implementation plan

**Status: approved by the owner on 2026-11-20, with the recommended answers to O1–O3. In progress.**

**Progress (2026-11-21):** phases 1–5 are merged into `main` (latest `c647775`; full suite 630 pass, 0 fail, 0 skip). Phase 1 `45fa188`, phase 2 `c8715b2`, phase 4 `6138f77`, phase 5 part one `619a159`, phase 3 and phase 5 part two (Jellyfin browser sign-in) `c647775`. Vigrid runs `19a9c08` (phases 1–4 and phase 3, without Jellyfin browser sign-in) with config schema v2z; its migration was run outside the scripts in `personal/migrations`. Phases 6 (manage sources in Server settings) and 7 (setup wizard) are not started. Waiting on the owner: the entry, Accounts, Jellyfin sign-in and setup screens, the TLS proposal (`docs/tls-and-remote-access.md`) and the watch-status switch wording.

## Approach

Seven phases. Each one leaves the full suite passing, is deployable to Vigrid on its own, and changes one boundary at a time. Access changes come first, while there's still one Plex and one Jellyfin. Removing personal entitlement makes each source much simpler, so phase 2 has less to turn into a list.

| Phase | Outcome | Config change | Database change | UI approval |
| --- | --- | --- | --- | --- |
| 1 | Admitted means everything | Removes fallback and `require_plex` keys | — | — |
| 2 | Any number of sources | `sources:` list replaces `plex:`, `jellyfin:`, `local_media:` | Folder `serverId` rewrite (O2) | Source names in the library |
| 3 | Identity, admission and entry rules | New `access:` shape | — | Entry page, password guest name |
| 4 | uburoom accounts | `access.accounts` | **Schema bump** | Account management, sign-in form |
| 5 | Jellyfin sign-in, members and watch sync | Per-source member rule | — | Jellyfin sign-in |
| 6 | Manage sources in Server settings | Writes `sources:` | — | Sources panel |
| 7 | First-run setup | Writes a whole config | — | Revised wizard |

Docs and rules (`AGENTS.md`, `SPEC.md`, `docs/accounts-and-access.md`, `docs/self-hosting.md`, `config.example.yaml`, `ROADMAP.md`) change in the phase whose behaviour they describe, never ahead of the code.

## Phase 1 — Admitted means everything

**Goal:** any admitted person can browse and play every library of the current Plex, Jellyfin and folder sources with the source's own credential. Entry rules stay as they are for now.

- `server/plex-provider.js`: `scopeFor` returns the source scope for any admitted actor. Remove the personal-credential and fallback branches.
- Remove `plex.fallback_enabled`, `fallback_token`, `direct_fallback_enabled`, `access.require_plex` and `require_plex_in_activity`, from `server/config.js`, `config.example.yaml`, `scripts/doctor.js`, `server/plex-auth.js`, `server/plex/delivery.js`, `server/sharing.js`, `server/access-policy.js` and the client's "Connect Plex to continue" gate.
- Direct delivery (O1): stays as a per-source option, allowed only when the source's credential is a dedicated non-owner Plex account. It replaces `direct_fallback_enabled` and is never an access path.
- Personal Plex watch-state sync (`server/plex-reporting.js`) stays as an opt-in linked-account feature. Activity reporting uses the source credential.
- Remove the Plex member directory (`directory.expose_plex_members`, the Plex part of `server/user-directory.js`).
- Update `AGENTS.md` (identity and access bullets), `SPEC.md` (guests use all media), `docs/accounts-and-access.md` (authorization contract, sharing policy), `docs/self-hosting.md` (remove the shared Plex fallback section).
- **Tests:** rewrite the entitlement and fallback tests in `tests/installation-policy.test.js`, `tests/accounts.test.js` and `tests/config.test.js`. A viewer with no Plex link, a Discord member and a room guest can all play Plex, Jellyfin and folder media. Refused people get nothing from any source. Revoking admission still ends media access within the recheck window.
- **Vigrid:** removed keys make the old config invalid. Use the config-rename order: deploy (expected failure), run a private `personal/migrations` script that deletes the removed keys, deploy again.

## Phase 2 — Any number of sources

**Goal:** a `sources:` list with any number of Plex, Jellyfin and folders entries. No source is special anywhere outside its own module.

- Add `server/sources/` with a registry and one module per type (`plex/`, `jellyfin/`, `folders/`), each exporting `validate`, `create`, `check`, and later `connect` and `members`. Move today's code into them: `server/plex.js`, `server/plex/`, `server/plex-provider.js` and the source half of `server/plex-auth.js`; `server/jellyfin-provider.js`; `server/local-provider.js` and `server/local/`.
- Every source module takes its config entry as a parameter. Nothing reads `config.plexUrl`, `config.plexToken`, `config.jellyfin*` or `config.localMedia` any more.
- The Plex server pin becomes per source (`machine_identifier` in the entry, remembered in `meta` under the source's id). The single `plexMachineIdentifier` key goes away.
- `server/app.js` builds providers from `config.sources` through the registry. `server/media-providers.js` gains "unavailable" for media whose server identity has no configured source. Two entries with the same server identity are a config error.
- Page bootstrap: `plexConfigured` becomes a list of sources with name, type and availability. Client wording that says Plex where it means "the media source" becomes neutral.
- Doctor: `checkProviderConnectivity`, `checkJellyfin` and `checkLocalMedia` become one loop calling each source's `check`.
- Interim entry rule until phase 3: Plex sign-in admits people with access to **any** configured Plex source.
- **Tests:** two Plex sources (fixture servers with different machine IDs), one Jellyfin and two folders sources. Libraries merge and are labelled. Queue entries resolve to the right source. A removed source shows as unavailable and comes back when re-added. Duplicate identity is rejected.
- **Vigrid:** convert `plex:`, `jellyfin:` and `local_media:` into `sources:` with a private migration script, using the config-rename order. The same script rewrites Vigrid's folder queue entries and resume positions to the new folders identity (O2).

## Phase 3 — Identity, admission and entry rules

**Goal:** the owner picks entry rules; any one admits.

- `server/identity/`: Plex (plex.tv PIN, account ID only, no server) and Discord, split out of `server/plex-auth.js` and `server/http/auth.js`.
- `server/admission/`: replaces the rule logic in `server/access-policy.js` and `server/access.js`. Rules: Discord server, members of chosen Plex sources (through the Plex module's `members`), server password, room invites. Keep the five-minute recheck, outage behaviour and Activity checks exactly as they are.
- **Server password (S3):** `secrets.server_password` replaces `entry_password` and becomes its own way in. After the password, the person types a name or keeps an offered ubumfa word (`shared/ubumfa.mjs`). That creates a server-wide guest (the existing `users.guest` model), with the sign-in kept in a long-lived browser session. The password's revision is stored, so changing it ends every session admitted with the old one. Rate limit wrong guesses like the existing invite-code limits.
- Operator: any verified identity (`operator` config accepts a provider and subject).
- Sign-in page shows only the buttons for enabled rules.
- **UI approval first:** the entry page with several sign-in buttons, the password step and the name-or-ubumfa step.
- **Tests:** each rule admits on its own; nobody matching no rule gets in; Plex source A's members don't get in through a rule naming only source B; switching a member rule off hides no media; changing the password ends password sessions; a password guest keeps their name in the same browser.
- **Vigrid:** new `access:` shape, so the config-rename order again.

## Phase 4 — uburoom accounts

**Goal:** the operator creates accounts; people sign in with a username and password (S2).

- **One schema bump for the whole plan** (13 → new baseline):
  - a table for uburoom account passwords (username, scrypt hash and parameters, one-time link token hash and expiry);
  - `credentials` keyed by `(provider, subject)` instead of `subject` alone, which phase 5 needs for Jellyfin tokens. Today it assumes every stored credential is Plex.
- Server settings: Accounts section (create, issue a new link, disable). Set-password page from the one-time link. Sign-in form. Rate-limited.
- **UI approval first:** account management, the set-password page and the sign-in form.
- **Tests:** link single use and expiry; wrong passwords rate-limited; disabled accounts lose admission; hashes and tokens never in responses or logs; operator can be a uburoom account.
- **Vigrid:** schema bump procedure: stop uburoom, `deploy-vigrid.ps1 -ManualLifecycle -BackupState`, run the reviewed database migration, rerun the deploy.

## Phase 5 — Jellyfin sign-in, members and watch sync

**Goal:** Jellyfin matches Plex for sign-in, entry and personal watch status (S4, S9).

- Jellyfin identity per source: Quick Connect when the server has it on, otherwise username and password passed once to that server and never stored. Identity is `jellyfin:<serverId>` plus the Jellyfin user ID; the user's token is stored encrypted under that provider.
- `members` for the Jellyfin module: signing in to that server is the proof.
- Personal watch-state sync for Jellyfin: progress and played state written only to the viewer's own Jellyfin account, opt-in, alongside the Plex version. Factor what both share into one linked-account sync interface so Emby plugs in later.
- **UI approval first:** the Jellyfin sign-in screen and the sync setting.
- **Tests:** against a fixture Jellyfin; the demo repo's real Jellyfin profile for an integration check (with your permission).

## Phase 6 — Manage sources in Server settings

**Goal:** add, test and remove sources in the browser; changes apply after restart (S8).

- A Sources panel using each module's `check`, and `connect` where it exists (Plex PIN and server discovery, Jellyfin discovery and sign-in, a folder browser).
- The config editor gains a validated `sources:` edit path. Today it edits 19 fixed keys; source entries contain secrets, so it needs its own narrow, create/remove-only path rather than general YAML editing.
- **UI approval first.**

## Phase 7 — First-run setup

Build the approved setup mode on top of phases 1–6. The mockup is revised first for: Your account (Plex or uburoom account), Media sources (add any number, reusing the phase 6 connectors), Who can get in (entry rules), Where people watch, Check, Ready (already signed in). Then UI approval, then the build.

## Later

Emby source (module, identity, members, watch sync), live source changes, merging the same title across sources, remote access guide.

## Answered questions (2026-11-20)

- **O1 — Direct delivery on Vigrid.** Vigrid uses `delivery: 'auto'` with direct fallback delegation, so viewers stream straight from Plex. S5 says proxy only at first, which would route all of Vigrid's playback through uburoom from phase 1. Options:
  - (a) accept proxy-only on Vigrid until a later phase;
  - **(b, approved)** keep direct delivery in phase 1 as a per-source option with today's safety rule: it only works when the source's credential is a dedicated non-owner Plex account, because the browser receives a token derived from it.
- **O2 — Folders queue history on Vigrid.** Phase 2 gives each folders source its own server identity, so Vigrid's existing folder queue entries and resume positions point at the old fixed identity. **Approved:** the private migration script rewrites those rows to the new identity. Alternative: let them show as unavailable.
- **O3 — Order of phases 3–5.** **Approved:** as listed. If you'd rather have uburoom accounts early, phase 4 can come before phase 3, at the cost of building it against the old admission code.
