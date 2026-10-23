# Account names and host directory

Implemented M1-P13/P14 contract; real provider mapping and user acceptance remain open in [testing](testing.md).

## Accounts and names

- One canonical UUID and independently editable name, seeded at first sign-in. Provider refresh/link/unlink preserves it; verified merging keeps the surviving account's name. Cosmetic edits do not sign users out.
- Names are normalized, trimmed plain text, 1–80 Unicode characters, without control/invisible characters. Duplicates are allowed; aliases/handles or a short discriminator distinguish results. Names/emails never prove identity or grant authority.
- Discovery creates no accounts. `signedInAt: null` means never authenticated; `0` means a known account with unknown historical sign-in time. Private placeholders are not treated as authenticated users.
- Native login and owner name-lock rules remain deferred.

## Host authority

**Add hosts** is a host-only permission, off by default. Authorized hosts can assign known accounts or exact provider subjects but cannot remove other hosts or pending grants. Removal belongs to the leader/active administrator; explicit hosts may relinquish their own role with a warning about lost private/closed-room access.

**All hosts** is persistent, reversible and controlled only by the actual leader—even an administrator cannot toggle it. It makes admitted members effective hosts without creating assignments. Presets preserve the mode; disabling it restores explicit roles. Private entry/reopening still requires explicit membership or active Admin authority. Relinquishing an explicit role while All hosts is on does not remove the mode-derived role.

## Search and pending assignments

Room-scoped search checks authority before and after provider work, rate-limits requests and returns at most 20 results. Mutations check current room revisions. Never expose credentials, emails, full provider profiles or the owner account endpoint.

Rank matches by:

1. Present in this room.
2. Connected elsewhere, including the lobby.
3. Previously signed in.
4. Never-signed-in provider members.

Within the last two groups, positively observed Discord presence comes first, followed by stable name order. Unknown presence is not offline; Plex presence is not queried. Deduplicate authenticated sockets by canonical UUID, separately from reconnect reservations.

Results show name plus status/source/alias. Arrows select, Enter grants only the selected result, Escape dismisses; existing assignments are disabled. Unlinked identities stay distinct.

Known accounts receive UUID assignments. Other targets receive durable exact provider/subject grants with issuer/time and server-derived labels. Authenticated admission plus verified identity claims them; disabling discovery does not hide or revoke pending grants. No name matching, messages or shared credentials are involved.

## Provider exposure

`directory.expose_discord_members: true` and `directory.expose_plex_members: false` are defaults. Previously authenticated users remain searchable with either off. Discovery never grants sign-in, room or media access.

| Provider | Boundary |
| --- | --- |
| Discord | Configured guild only; exclude bots and bound pagination. Request optional member/presence intents only when application flags permit; missing capabilities warn without disabling ordinary operations. Read presence only from a ready shard. |
| Plex | Configured owner token and pinned server's accepted library shares only. Exclude managed profiles, pending invitations, other servers, emails and shared-user tokens. Bound responses to 4 MiB; reject external XML entities. Unsupported privilege/shape reports unavailable. |

Search debounce is 250 ms; shared success cache 60 seconds and failure backoff 15 seconds. Provider failure leaves local search available with a truthful notice.

References: [Discord intents](https://docs.discord.com/developers/events/gateway#privileged-intents), [application flags](https://docs.discord.com/developers/resources/application#application-object-application-flags), [Plex roster mapping](https://github.com/pushingkarmaorg/python-plexapi/blob/master/plexapi/myplex.py).

## Storage and verification

Use the existing SQLite mirror/writer and validated room operations. Preserve explicit host rows and canonical merges. Current baseline and private-transfer requirements are in [upgrading](upgrading.md), not a separate directory migration.

Check authorization races, restart preservation, provider failure and browser interaction in fixtures; actual Discord intents/presence, Plex roster mapping and human usability need separate evidence.
