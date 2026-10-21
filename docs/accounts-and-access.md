# Accounts, administration and Plex reporting

Updated: 2026-10-20. YAML configuration, entry/provider/password policies, explicit fallback sharing, Activity-only playback, single-room mode and conversion controls are implemented in the working tree; broader administration UI, identity security and guest-pass work below remain planned. This plan supports roadmap M1-P14 (configuration/accounts), the high-priority reporting track in M1-P4, and M2-P3 (guest passes). It does not authorize deployment, production configuration changes or live experiments that modify personal Plex history.

## Current boundary

Accounts already use stable UUIDs and verified provider subjects, with explicit merging, conflicting-identity rejection, browser-bound provider flows and login invalidation after merge/unlink. Durable room creators/hosts resolve canonical UUIDs. Discord Activity has provider authentication and an authorization-based Open in web app handoff; preserve both Discord login and that handoff.

The authorization review found implicit owner-token fallback. The owner has now explicitly chosen enabled-by-default sponsorship, documented prominently in private YAML, hosting instructions and startup output. Fallback applies to no attached Plex account or positively confirmed lack of server membership when personal Plex admission is not required. Revoked/expired credentials, provider errors and item-level restrictions fail closed. Removing a Plex identity may permit configured sponsorship: that sharing choice must remain visible to the operator rather than being described as personal entitlement. A dedicated fallback token can replace the server account's scope. Native per-viewer observations/history exist; intentional per-viewer Plex reporting remains unfinished. Record implementation and live verification evidence in [testing.md](testing.md).

## Configuration and administration

Start with an inventory of `config.yaml` settings, room defaults, account/role state and hard-coded policy. For each setting, identify its purpose, type/default, validation, secret status, authority, persistence, update permissions, restart requirement and effect on existing viewers.

Design a proper in-app administration panel covering provider/admission policy, accounts and access, room defaults/invitations, Plex integration/reporting, guest sponsorship, and bounded operational status/audit information. It must show effective policy and explain material access changes before saving. Validate and authorize on the server, await durable persistence, protect secrets, and distinguish a failed save from an unapplied restart-required change. The existing room Admin mode is not itself a settings panel or universal credential-management permission.

Current configuration authority is private `config.yaml`, following the authorized YAML transition. Decide explicitly how the panel edits that authority or how a reviewed split between deployment secrets and mutable settings would work; until then, keep YAML authoritative. Never expose the secret-bearing file through the panel, create competing values or introduce `config.json`. Identify locked deployment settings, secret rotation, safe recovery and who can change each class before implementing storage or UI.

Support an operator identity/recovery path for installations using Plex, Discord or both. Do not infer installation ownership from an ordinary room host or from matching a display name. Prevent removal/disablement of the last usable administrative sign-in. Configuration edits must not restart services or change provider registration implicitly.

## Authorization contract

| Layer | Required distinction |
| --- | --- |
| Identity | A canonical uburoom UUID has exact verified Plex/Discord subjects; display names confer no authority. |
| Sign-in | Plex, Discord or both offered as alternatives; this does not imply both memberships are required. |
| Admission | Personal Plex access, Discord guild/role eligibility, both, or an explicit invitation according to operator policy. |
| Media | Personal Plex entitlement by default, or an explicit sponsored grant constrained by authorized source, library/item and room. |
| Roles | Viewer, host, creator and server administrator are separate from media entitlement and remote consent. |
| Reporting | Personal Plex attribution requires the viewer's authorized Plex identity; sponsored source access does not create one. |

Canonical-account suspension/denial takes precedence over alternate provider routes and pass redemption. Recheck current permissions around awaited work. Apply policy to browser, Activity, handoff, bot, sockets, catalog, metadata, artwork, captions, queues, direct media, HLS and AV1. Define bounded provider-cache revocation and invalidate live access on local policy changes.

Produce a scenario matrix before implementing settings: each provider alone; linked providers; both required; disabled provider; absent/revoked Plex credential; Discord membership/role loss; explicit sponsorship; guest; canonical merge/deny; and existing sessions after configuration changes. Hiding a button is insufficient enforcement.

## Account changes, names and invitations

Require recent authentication of the initiating account before sensitive link, unlink and merge actions, as well as verification of an incoming provider. A long-lived browser cookie alone should not let another person attach a new permanent login. Show the affected subjects and consequences; retain one identity per provider, conflict rejection, last-usable-login checks and UUID continuity. Provide all-session revocation, authentication-age/session-lineage records and clear recovery. Reauthentication is for sensitive account changes, not every watch request or routine authorized handoff.

Test both linking directions, replayed/expired callbacks, browser/account switching, simultaneous changes, logout/revocation during provider calls, stale merge previews, manual owner assignments and durable-write failure. Review merged roles/history and deny precedence. Clearly distinguish manually assigned provider subjects from proven identities and decide acceptance requirements before inheriting access through an assignment.

The implemented model uses one uburoom display name seeded by first sign-in and editable independently of either provider; owner name-lock rules and native authentication are deferred. Search current provider names as aliases and return one canonical UUID result after verified linking; directory-only profiles remain separate until proof. Linking/unlinking must not change the displayed account name. The [account names and host directory plan](account-names-and-host-directory.md) details host-only Add hosts permission (off by default), self-demotion, offline assignments, two-line ranked results and Discord-on/Plex-off directory exposure. The leader-only All hosts switch temporarily gives admitted members host roles while preserving explicit assignments for when it is disabled. Local fixture/browser coverage is recorded; real-provider verification remains open.

Extend existing offline UUID-based host assignments with account search and pending invitations bound to exact provider subjects. A person who has not registered proves the intended identity before accepting. Validate room, role, expiry and current inviter authority; re-evaluate on merge/unlink/revocation. An ordinary bearer guest pass must not claim a named host invitation. Separate unlinked accounts remain distinct until verified merging.

## Discord Activity and browser handoff

Preserve existing Discord sign-in and the Activity's Open in web app feature, including use of Activity authorization to establish the web login. Keep expiry, one-use redemption, source-grant validation and confirmation when the browser is signed into a different account. Preserve the canonical account, current admission/media policy and room eligibility across the transition; never silently broaden rights or select a different identity.

Also support Plex-only admission while retaining verified Discord Activity context. Existing verified links may resolve the entitled Plex account; otherwise bind a browser Plex proof to the exact pending Activity attempt. Define whether that association is temporary or an explicit permanent account connection. Context authentication alone must not silently enable Discord as a permanent uburoom login, bypass an explicitly disabled sign-in route or replace Plex entitlement.

Separate optional guild/bot admission rules from SDK context verification. Test Discord-only, Plex-only and linked users, first-time linking, account mismatch, expired/replayed handoff, source revocation, disabled providers and concurrent browser/Activity use. Real Discord/proxy checks and Chrome/Firefox verification remain required.

## Plex activity and viewer attribution

Treat this as a high-priority foundation alongside authorization. Define and verify three different outcomes: Plex server activity/dashboard visibility, personal Plex resume/watched-state effects, and uburoom's own per-viewer playback/history/status. Do not assume a successful timeline request or an encoder's activity proves each outcome.

Authorized [watch-state separation probes](plex-reporting-investigation.md#activity-only-reporting-and-personal-state-separation) found a working activity-only request shape on PMS 1.43.0.10231 with Chrome Original playback, subsequently extended to bounded HLS and AV1 checks: retain both real item identifiers, authenticated viewer and actual position, but omit timeline duration. Correct-user/movie activity continued while personal resume, played count, last-viewed and filtered history stayed unchanged, including same-client sync-on → off transitions. Original/HLS reached natural ending; AV1 required explicit stop near the final frame. Plan an independent user preference **Update my Plex progress and watched status**, subject to compatibility verification for each supported delivery path/server version. Plex active entries and account-attributed server log events were verified; persisted aggregate usage statistics were not. This is empirical behavior, not a documented cross-version guarantee. The [delivery-association follow-up](plex-reporting-investigation.md#plex-delivery-association-investigation-2026-10-20) resolves isolated HLS classification with consistent playback-session identity and distinct viewer/job IDs. A linked stopped report terminates the producer; detaching the stop leaves stale activity. External AV1 output fields were ignored by PMS. Resolve shared-producer lifecycle and truthful external-delivery telemetry before broader claims; the AV1 ending gap remains separate. Shared producers, other browsers/Activity and sponsorship remain unverified.

| Viewer | Media authority | Reporting requirement |
| --- | --- | --- |
| Verified Plex viewer, with either permitted login method | Their own current Plex entitlement | Report actual playback under that Plex identity; independently honor personal-state sync preference on verified paths and preserve distinct uburoom viewer history. |
| Discord-only sponsored viewer | Explicit operator grant and constrained authorized source | Track the viewer locally; expose what Plex can actually attribute to the source. Do not fabricate a personal Plex identity. |
| Guest without Plex access | Revocable pass plus explicit sponsored media grant | Keep bounded guest identity/progress and truthful reporting status in uburoom; do not write owner personal watch state for the guest. |
| Multiple viewers sharing a conversion | Each viewer independently authorized | Source/transcoder ownership does not replace each viewer's reporting identity or actual playback evidence. |

**Open decision: sponsored playback.** Determine with controlled Plex tests how an explicit source credential appears on the dashboard, what progress/history side effects occur, and whether a dedicated restricted source identity or a different supported mode is needed. A client label cannot be promised as a distinct Plex user. Keep source/transport credentials separate from personal-reporting credentials. If per-person reporting is unavailable for guests, show that limitation truthfully in uburoom while retaining separate local observations. Never solve missing guest identity by impersonating the Plex owner or advertise dashboard-only reporting without verifying its watch-state effects.

Drive reports from observed viewer playback, including actual position and paused/buffering/stopped state, rather than room intent or transcode progress. Pin attribution to verified Plex subject, server/media identity, playback occurrence and device/viewer lifetime. Linking/unlinking must not retroactively reattribute history. Coordinate duplicate tabs, handoff and concurrent devices; fence stale retries/reconnect work and avoid resume conflicts with newer external playback. Stop on entitlement loss and define crash/restart cleanup without replaying stale watch-state writes.

Serialize personal-sync transitions: settle already-dispatched writes before acknowledging opt-out, cancel stale queued full-sync work and preserve the setting across stop/ending, quality replacement, reconnect and Activity handoff. Never silently enable personal sync when activity-only compatibility is unverified. The timeline response's playbackState alone is not a persistence or capability check; verify metadata/history and exact media attribution.

Verify Original, HLS and AV1 separately on real Plex: late join, seek, buffering, no decoded advancement, background/sleep, pause, disconnect, quality replacement, shared conversion, revoked token, two devices for one subject and browser/Activity handoff. Preserve native history and document privacy/consent, retention and any reporting options. Live tests that change history use consenting isolated accounts and their existing authorization requirements.

## Guest passes

Implement after the explicit-grant and reporting-attribution foundations. Start with temporary passes rather than a new permanent password-account system. Use hashed high-entropy tokens, room scope, expiry, revocation, atomic redemption limits, attendance/concurrency ceilings and bounded reconnect. Mark chosen guest names as unverified and rate-limit redemption.

Operators decide whether hosts may issue passes and sponsor media, with source/library/item ceilings and resource limits. Admission alone never grants a wider Plex library. Guests retain personal volume/track choices but cannot gain host/admin rights or permanent room ownership through room participant presets. Revocation invalidates already-open sockets and media/caption/artwork grants. Conversion to a registered account requires fresh provider proof and a defined history/role transfer policy.

## Ordered increments and completion gates

1. Inventory configuration and draft admin sections, settings authority/restart behavior, admission/media matrix and personal/sponsored reporting matrix. Resolve the material sponsorship and operator-recovery choices before enabling new access.
2. Implement a bounded policy foundation closing implicit owner-token escalation, with regression checks for absent/unlinked/revoked identities and intended explicit sharing. Build validated admin settings on that authority rather than duplicating policy in the UI.
3. Harden sensitive account changes and verify operator recovery, policy-change revocation and existing Discord login/Activity-to-web behavior.
4. Use the verified isolated HLS association; resolve pooled-producer stop behavior and external AV1 telemetry boundaries, then extend activity-only checks to shared producers, browsers, Activity and lifecycle/concurrency boundaries, then implement a controlled personal-account reporter with independent personal-sync preference. Separately verify sponsored-source behavior; expand Activity/Plex-only association using the same identity/attribution contract. Reporting investigation begins in step 1, not after guests ship.
5. Follow the account-name/host-directory increments for stable display names, known-account search/host delegation, then Discord and optional Plex discovery; then implement limited guest passes with the verified media/reporting model.

Each implementation increment records targeted regressions and actual provider/browser evidence in [testing.md](testing.md). Do not mark planned behavior implemented, a fixture as live-provider proof, or the whole direction authorized for immediate implementation solely because it appears in this roadmap.

For new M1-P14/M1-P4 checks, classify A policy/source review, B isolated adversarial/auth/history tests, C authorized real Plex/Discord/Activity checks, and D targeted administrator UX acceptance under the [testing standard](testing.md#verification-standard-for-new-work). Keep operator policy decisions and permission for live account/history experiments separate from level D.
