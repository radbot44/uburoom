# Account names and host directory

M1-P13/P14 implementation contract. Leader-only reversible All hosts and editable names were approved on 2026-10-20. Local fixture verification is recorded in [testing](testing.md); real-provider verification remains open.

## Accounts and names

An uburoom account has one stable UUID and one display name. Successful provider sign-in creates the account and seeds its name once. Account settings let the person edit it. Provider refresh, linking and unlinking preserve it; verified merging keeps the surviving account's name. Future native authentication can attach to this model. Native password login and owner name-lock policy remain deferred.

Names are plain text, 1–80 Unicode characters, normalized and trimmed, without control/invisible formatting characters. They need not be unique. Search includes verified provider aliases and supplies handles or a short account discriminator for ambiguous names. Names and emails never prove identity, merge accounts, choose credentials or grant permissions.

Browser, Activity and bot actors resolve canonical names. Cosmetic edits do not increment authentication revisions or sign users out. Provider linking/removal/merge retain their authentication boundaries.

Discovery does not create accounts. Private owner-assigned placeholders remain distinct from successful sign-in; search excludes these unless an enabled provider source discovers them. New accounts record first sign-in in `signedInAt`. For retained state, null means never authenticated; 0 means previously known with the historical date unknown.

## Host authority

**Add hosts** is a host permission in Room management, off by default in existing policies, new-room defaults and presets. Participants cannot receive it. Authorized hosts can add known accounts and pending provider assignments, but cannot remove another host or pending assignment. Appointed hosts inherit the same host policy.

Ordinary removal stays with the leader or an authorized administrator in explicit Admin mode. Explicit hosts may relinquish their own assignment in People even without Add hosts. Confirmation explains possible private/closed-room access loss. Leaders use the existing leadership-transfer workflow instead.

**All hosts** is a persistent, reversible switch in Permissions, controlled only by the actual room leader. Admitted members are displayed as hosts and use the host permission column. Participant settings are retained for when it is disabled; presets preserve the mode. Room-panel quick switches edit host controls while it is on. People still permits explicit assignment/removal. Relinquishing an explicit role while the mode is on leaves the person a host through the mode; confirmation explains this.

The mode creates no permanent assignments, grants no server admission and exposes no private rooms. Private entry and saved-room reopening continue to require explicit membership or current Admin authority. Turning it off restores explicit-host/participant roles. Neither hosts nor administrators can toggle the leader-only mode through the API.

## Search and pending assignments

Authorized actors see Add a host search in People. The room-scoped socket operation checks admission/role before and after provider work, limits requests and returns at most 20 results. Mutations use current room revisions and recheck authority. Search never exposes the owner account-management endpoint, credentials, emails or full provider profiles.

Match the uburoom name and provider aliases, then rank:

1. Present in this room.
2. Connected elsewhere in uburoom, including the lobby.
3. Previously signed in, currently disconnected.
4. Provider members who have never signed in.

Within groups 3 and 4, positively observed Discord online/idle/do-not-disturb users come first. Remaining entries use stable name ordering. Unknown presence is not claimed offline; Plex presence is not queried. Actual uburoom presence follows authenticated live sockets, deduplicated by UUID, separately from reconnect capacity reservations.

Results have a name and status/source/alias caption. Arrows select, Enter grants only the selected result and Escape dismisses results. Existing assignments are disabled. Unlinked identities remain distinct until verified linking proves one account.

Known targets receive UUID host assignments. Never-signed-in targets receive durable pending grants for an exact provider/subject, with issuer/time. Labels come from the enabled directory rather than mutation bodies. Authenticated admission lets exact verified identities claim grants. Pending grants remain visible/revocable after discovery is disabled. Claimed grants become ordinary canonical host memberships. No messages, email, shared credentials or automatic name matching are involved.

## Provider exposure

```yaml
directory:
  expose_discord_members: true
  expose_plex_members: false
```

These options expose new candidates; they do not enable sign-in or grant installation/media access. Previously authenticated accounts remain searchable with either source off.

Shared bounded caches retain successful results for 60 seconds with 15-second failure backoff. Failures leave local search usable with a truthful notice. Search is debounced by 250 ms; no full roster request occurs per keystroke.

Discord discovery pages only the configured guild, excludes bots and bounds pages/results. Before gateway login, optional member/presence intents are requested only when application flags advertise them. Missing capabilities produce setup warnings without preventing ordinary configured bot operations. Presence is read only while the guild/shard is ready. See [privileged intents](https://docs.discord.com/developers/events/gateway#privileged-intents) and [application flags](https://docs.discord.com/developers/resources/application#application-object-application-flags).

The optional Plex adapter reads plex.tv's account roster with the configured owner token, keeping accepted library shares for the verified configured machine identifier. Managed profiles, pending invitations, other servers, emails and shared-user tokens are excluded. Unsupported responses/token privileges report unavailable. Responses are bounded to 4 MiB; external XML entities are rejected. Mapping follows the [Python-PlexAPI implementation](https://github.com/pushingkarmaorg/python-plexapi/blob/master/plexapi/myplex.py); fixtures do not establish live Plex compatibility. [Plex distinguishes library access from friendship](https://support.plex.tv/articles/201105738-creating-and-managing-server-shares/).

## Storage and verification

SQLite baseline 6 adds nullable `users.signedInAt` and provider-bound pending grants. All hosts lives in existing policy JSON; explicit host rows remain intact. Startup rejects older private schemas unchanged. Retained installations need an explicit reviewed private transfer, matched backup and exact original key. No migration is shipped or run automatically.

Implementation uses existing native browser modules, account service, SQLite mirror/writer and validated room operations, with no new dependencies or credential database.

Required evidence: A authorization/schema review; B unit/socket/provider fixtures, restart preservation, migration idempotence and Chrome/Firefox desktop/phone UI; C actual Discord intents/member/presence and Plex roster mapping; D user acceptance. Local B does not close C or authorize provider setup, production migrations or deployment.
