# Upgrading

uburoom uses `/ubu` and `!ubu` exclusively. At startup, the bot replaces this application's command set in its configured guild with `/ubu`; it does not change commands belonging to other applications or publish global commands.

The Firefox extension ID is `uburoom@uburoom.com`. Install it as a new extension and pair it with your installation. Its private authentication callback is derived from that ID. Configure the build for your installation's exact HTTPS origin. There are no previous-name aliases for extension identity, storage, cookies, globals, protocol fields, launchers or logo routes. Browser users must sign in again after the naming transition.

Keep existing account UUIDs, linked identities and encrypted data. Before starting an existing database, copy the exact original 32-byte encryption key into the runtime user's `LOCALAPPDATA/uburoom/credentials.key` (or the equivalent home directory on other platforms), or set `UBUROOM_CREDENTIAL_KEY_FILE` to its private absolute path outside the project. Never generate a replacement key for existing accounts. Back up the matched database/state and key before upgrading; startup refuses an existing database with a missing key.

Use only the uburoom launchers. Select a tested revision, install dependencies on the runtime machine and restart during an agreed maintenance window. Keep private state outside Git and preserve it when replacing code. See self-hosting.md for backups/deployment and testing.md for pending live verification.
