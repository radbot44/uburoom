# Branding and compatibility

Visible text is lowercase **uburoom**. Original graphics remain pending replacement. Source/server and extension versions stay 0.5.3 and 0.4.14 during migration.

These technical identities intentionally remain:

- Firefox Gecko ID `radtv@tch.one` and its derived private authentication callback.
- Extension storage/connection names, JavaScript globals, DOM/CSS names and internal protocol/media fields.
- Browser cookies, database UUIDs/values, Plex client identifiers and encrypted account data.
- `RADTV_CREDENTIAL_KEY_FILE` and the original key directory/name. Never recreate the key for existing accounts.
- `!radtv` / `/radtv` routing and legacy launcher/asset paths. New command aliases/registration need a separate compatibility/deployment decision.

They preserve installed users/state and are not required installation hostnames. Source remote defaults to localhost; configure-remote.js creates a build for your own narrowly permitted HTTPS origins. A paired profile keeps its selected URL: include that exact origin in an upgrade build. No build resets credentials or silently changes the selected server.

Changing PUBLIC_URL affects origin-bound logins, host-scoped cookies, OAuth callbacks and Activity mappings; reauthentication may be required. Preserve accounts, device records and the original key independently of hostname changes. Clean-install and existing-instance upgrade checks remain necessary before release.
