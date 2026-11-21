# Media sources and admission

**Status: design approved by the owner on 2026-11-20 (S1–S9, with the owner's changes to S3 and S4). Not implemented.** This comes before the [first-run setup](first-run-setup.md) wizard, which will be built on it.

## The model in one sentence

**The owner picks which rules let people in. Anyone let in can watch every media source on the server.** No source is privileged. A source's members can be one of the entry rules, but only if the owner picks that rule, and it never limits what an admitted person can watch.

```
Entry rules the owner picks (any one is enough):
  Discord server · members of a Plex/Jellyfin source · server password · uburoom accounts · room invite
                                  │
                                  ▼
                          admitted person
                                  │
Media sources (Plex, Plex, Jellyfin, folders…)  ──►  everything, for everyone admitted
```

## Rules

1. **All sources are equal.** Plex, Jellyfin, folders and later Emby are each just a source. There's no primary source, no special Plex path and no `kind === 'plex'` decision outside that source's own module. Any number of sources of any type, including several of the same type.
2. **Entry and media are separate settings.** A source has a connection and a credential that uburoom uses to read media. Whether its members get in is an entry rule the owner turns on in the access settings, per source. Adding a source never lets anyone in by itself, and removing an entry rule never hides any media.
3. **Admitted means everything.** Anyone admitted can browse and play every library of every source. There's no per-viewer entitlement, so a room can always watch what the group picked. A viewer's own Plex or Jellyfin permissions play no part.
4. **Admission is the only gate, so it's all in one place.** Sign-in methods prove who someone is (Plex account, Jellyfin account, Discord, uburoom account). Entry rules decide whether they're let in, and any one matching rule is enough. Every rule is listed and switched in one place.
5. **Source credentials never leave the server.** Browsers get media through uburoom. A token, API key or path never appears in a response, link or page.
6. **Unavailable is not denied.** If a source is offline or removed, its items show as unavailable. They aren't deleted, and nobody loses admission because of it.

## What this replaces

This reverses the current approved access contract in [accounts and access](accounts-and-access.md), the `AGENTS.md` access rules and [SPEC.md](../SPEC.md).

| Today | After |
| --- | --- |
| Media access = personal Plex entitlement, or configured sponsorship (fallback) | Media access = admitted |
| Standalone Plex sign-in requires access to the pinned Plex server | Plex sign-in is an identity; "members of Plex source X" is an optional entry rule, per source |
| `secrets.entry_password` is an extra requirement on top of sign-in | The server password is its own entry rule: knowing it is enough (S3) |
| Only Plex and Discord identities | Adds Jellyfin accounts (per Jellyfin source) and uburoom's own accounts |
| `access.require_plex`, `require_plex_in_activity` | Removed |
| `plex.fallback_enabled`, `fallback_token`, `direct_fallback_enabled` | Removed. The source's own credential is used for everyone |
| One `plex:` and one `jellyfin:` section | A `sources:` list (see below) |
| Plex server pin kept in one global `meta` key | Pin stored per source |
| Direct Plex delivery with personal or delegated viewer credentials | Proxy only in v1 (already the default); per-source direct delivery revisited later (S5) |
| Plex member directory reads the pinned server's shares | Moves to admission as an optional people source, or is removed (S6) |
| Guests "use shared fallback media" (SPEC) | Guests are admitted, so they see everything like anyone else |

Kept as they are: canonical account UUIDs, verified identities, room roles and invites, server operator, Activity identity checks, revocation of admission and the five-minute admission recheck. These are already independent of media.

## Configuration

```yaml
sources:
  - id: 'living-room' # stable forever; never reused for a different server
    type: 'plex'
    name: 'Living Room' # optional; defaults to the name the server reports
    url: 'http://192.168.1.20:32400'
    token: '…'
    machine_identifier: '' # blank: detect once and pin
  - id: 'cabin'
    type: 'plex'
    url: 'https://cabin.example:32400'
    token: '…'
  - id: 'jf'
    type: 'jellyfin'
    url: 'http://192.168.1.30:8096'
    api_key: '…'
    user: 'uburoom' # the user whose libraries are offered
  - id: 'films'
    type: 'folders'
    libraries:
      - id: 'films'
        name: 'Films'
        paths: ['D:\Media\Films']
        type: 'movies'
```

- **`id`** is uburoom's name for the source in config and logs. Queues, progress and bookmarks keep using the **server identity** the source reports (Plex machine ID, Jellyfin server ID, a fixed local ID for folders), as they do today. So renaming or reordering config entries never orphans anything. Two entries that report the same server identity are a config error.
- **`folders`** becomes a source type. Today's `local_media.libraries` moves inside it unchanged. More than one `folders` source is allowed; its identity is derived from its `id` (S7).
- **Order** decides only the display order of libraries.
- **Per-source settings** that are global today (`delivery`, `client_url`, reporting) move into the source entry, or are removed (S5).
- **Prerelease:** the old `plex:`, `jellyfin:` and `local_media:` sections are removed with no compatibility handling. Vigrid's config is converted by a private migration script, using the deploy → migrate → deploy order.

## Code structure

- **One module per source type** (`server/sources/plex/`, `jellyfin/`, `folders/`, later `emby/`), each exporting the same contract:
  - `validate(entry)`: checks and normalizes the config entry; used by `server/config.js`.
  - `create(entry, services)`: returns a `MediaProvider` (the existing contract in `server/media-providers.js`), with `scopeFor` returning the full source for any admitted actor.
  - `check(entry)`: connection and credential test; used by the doctor, the setup wizard and Server settings.
  - `libraries(entry)`: every movie and show library on the server, offered or not, with item counts where known, for choosing which to offer. A Plex or Jellyfin entry's optional `libraries:` list names the server's own library ids it offers (absent: all, including later ones); the module enforces it wherever its media is reachable, and media in a library that is off is unavailable, never denied (owner request, 2026-11-21).
  - `setup`: the add flow Server settings drives (`steps`, each given a flow held on the server; `entry`, the settings to save; `summary`, what the panel may show). Secrets stay in the flow and the file.
  - `connect`: optional guided setup (Plex PIN and server discovery, Jellyfin discovery and Quick Connect, a folder browser), used by the wizard.
  - `members`: optional, for sources that have accounts (Plex, Jellyfin, Emby). Answers one question: does this verified identity have access to this server? Only admission calls it, and only for sources the owner picked as an entry rule.
- **A registry** maps `type` to module. `server/app.js` builds providers from `config.sources` through it, with no source named explicitly.
- **Three separate layers, each with one job:**
  - `server/identity/`: sign-in methods that prove who someone is: Plex (plex.tv PIN, no server involved), Jellyfin (against one Jellyfin source's server), Discord, and uburoom accounts. Today's `PlexAuth` splits here: identity moves to this layer, and the server client, pin and sessions stay in the Plex source.
  - `server/admission/`: the entry rules. It asks identity "who is this?" and, for a source member rule, that source's `members` capability. It's the only code that decides entry.
  - `server/sources/`: media only. A source never reads admission settings, and admission never changes what a source serves.
- **`MediaProviders`** stays the single entry point for rooms and streams. It already selects by server identity and merges libraries; it gains "unavailable" handling for identities with no configured source.
- **No source-type checks outside source modules.** The page bootstrap's `plexConfigured` becomes a generic list of sources and their names and availability, and Plex-only wording in the client becomes source-neutral.
- **Reporting** to a source ("now playing", watch state) is a capability of that source module, using the source credential. Personal watch-state sync to a viewer's own account on a source is a separate linked-account capability that Plex, Jellyfin and later Emby each provide (S4).

## Admission

The owner switches on any combination of entry rules. **Any one matching rule lets a person in**, and every admitted person can watch everything.

| Entry rule | How someone proves it | Notes |
| --- | --- | --- |
| Discord server | Sign in with Discord as a member of a server the bot joined and the operator allows | Any eligible server |
| Members of a Plex source | Sign in with Plex; their plex.tv account can reach that server | Picked per source. Today's "access to the pinned server" check, generalized |
| Members of a Jellyfin source | Sign in with a Jellyfin account on that server | Picked per source. Signing in to that server is the proof |
| Server password | Enter the password, then type a name or keep a random ubumfa word | A guest, not an account: the browser keeps the sign-in (S3) |
| uburoom accounts | Sign in with a username and password that uburoom stores | uburoom's own accounts (S2) |
| Room invite | Open `/join/<code>` | Admits a guest to that one room, as today |

Picking a source as an entry rule automatically offers its sign-in button ("Sign in with Plex", "Sign in with Jellyfin — Cabin"). Sign-in methods with no matching rule aren't offered.

```yaml
access:
  discord_server: true
  source_members: ['living-room', 'jf'] # source ids whose members may come in
  password: true # uses secrets.server_password
  accounts: true # uburoom accounts
  guests: { enabled: true } # room invites
```

The exact keys are for implementation. Existing behaviour carries over to every rule: confirmation is rechecked every five minutes, a provider outage doesn't remove someone already admitted, and nobody new gets in while their rule's provider can't answer.

The **server operator** can be any verified identity, including a uburoom account, so an install with only folders still has an owner.

## Behaviour details

- **Library listing:** every source's libraries, labelled with the source name. Duplicates of the same title on two sources show twice in v1; merging them is later work.
- **Offline source:** its libraries show as unavailable. Queued items from it can't start; the room skips to the next playable entry or shows the existing truthful error.
- **Removed source:** queued items and resume positions stay, shown as unavailable. Adding the same server back, with any `id`, restores them through its server identity.
- **Adding or removing sources** takes effect after a restart, like other saved settings (S8).
- **Plex sessions on the server:** all playback uses the source token, so on the Plex dashboard every viewer appears as the source account. uburoom's own history still records the real viewer.

## Tests

- An admitted viewer with no linked accounts browses and plays from two Plex sources, one Jellyfin source and one folders source.
- Adding a source admits nobody until its member rule is switched on; switching the rule off never hides that source's media from people admitted another way.
- Each entry rule admits on its own: Discord member, Plex source member, Jellyfin source member, server password, uburoom account, room invite. A person matching none is refused.
- Membership of Plex source A doesn't admit through a rule that names only Plex source B.
- Changing the server password ends password-admitted sessions.
- A password guest keeps their name across visits in the same browser and gets a new guest identity in another browser.
- Personal watch-state sync writes only to the viewer's own linked account on that source, for Plex and Jellyfin.
- A person refused by admission gets no library, artwork, subtitle or media response from any source.
- Revoking admission ends media access within the existing recheck window.
- Two config entries reporting the same server identity are rejected.
- Removing a source leaves its queue entries and resume positions intact and unavailable; re-adding restores them.
- No API response, page or log line contains a source token or API key.

## Documentation and rules to update with the change

`AGENTS.md` (identity and access bullets), `SPEC.md` (guests and media access), `docs/accounts-and-access.md` (authorization contract and sharing policy), `docs/self-hosting.md` (remove shared Plex fallback, add sources and admission), `docs/docker.md`, `config.example.yaml`, `ROADMAP.md` (M1 access gates), `docs/first-run-setup.md` (Sharing step removed; Media sources step added).

## Approved decisions (2026-11-20)

- **S1 — The model:** everyone admitted can use all sources. No personal entitlement and no fallback settings; Plex's per-person limits (ratings, library shares) don't apply in uburoom.
- **S2 — uburoom accounts:** the operator creates each account in Server settings and sends a one-time link where the person sets their password. Passwords are hashed with scrypt; recovery is the operator issuing a new link. Setup uses this to create the owner's account when they don't sign in with Plex.
- **S3 — Server password:** knowing it is enough to get in. After entering it, the person types a name or keeps a random ubumfa word offered to them. This is a guest name, not an account: there's no password of their own, the browser keeps the sign-in, and a new browser means a new guest. Changing the server password signs out everyone who got in with it. Wrong guesses are rate limited.
- **S4 — Personal watch-state sync:** kept as an opt-in, separate from access, for every source type with accounts: Plex and Jellyfin now, Emby when added. A viewer links their own account on that source and uburoom writes watch state only to that account.
- **S5 — Direct delivery:** v1 streams everything through uburoom. Direct delivery from a source can come back later as a speed-up, never as a way in.
- **S6 — Plex member directory:** removed for now. It can come back as a people list for a Plex source whose member rule is on.
- **S7 — Several folder sources:** allowed, each with its own identity from its `id`. Changing a folders source's `id` forgets its queue history.
- **S8 — Applying source changes:** adding or removing a source needs a restart, like other saved settings. Live changes later.
- **S9 — Jellyfin sign-in:** Quick Connect when the server has it switched on, otherwise username and password passed once to that Jellyfin server and never stored.
