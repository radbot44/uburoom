# First-run setup

**Status: design approved by the owner on 2026-11-20 (D1–D8 as recommended). Setup mode and the wizard are built to the approved mockup (phase 7 of the [media sources plan](media-sources-plan.md)); see [Implementation notes](#implementation-notes-2026-11-21) for where the build differs. The per-user default config location (first bullet of D4) was dropped by the owner on 2026-11-21: the default stays beside the code.**

**Revised 2026-11-20** for [media sources and admission](media-sources.md): the Plex-only steps and the Sharing step were replaced by Your account, Media sources and Who can get in, and the owner arrives already signed in. D5's setup question and D7 (Plex account must own the server) no longer apply. The setup code, transport, config location and hand-off decisions are unchanged.

## Goal

A person who has Plex but has never seen uburoom starts the server, opens one page, connects Plex and creates a room in under 10 minutes, without editing YAML, finding a Plex token or making a certificate. This is the acceptance test for the milestone. It covers use on this computer and the home network. Inviting friends over the internet with a trusted certificate is a separate decision (see [Out of scope](#out-of-scope)).

## Principles

- `config.yaml` stays the only configuration authority. Setup **writes a validated `config.yaml`** and keeps nothing else: no settings table, no second store.
- Setup mode is a different, much smaller server. It opens no database, provider, room or media code, and serves only the setup page and its API.
- Visiting the page grants nothing. Ownership needs a **setup code** (proves the person can see the server console or log) **and** a Plex sign-in (proves which account becomes the operator).
- The Plex token never reaches the browser. The PIN exchange and server discovery happen on the server.
- Defaults are the safe choice. Shared Plex fallback is **off** unless the owner turns it on in setup.
- Advanced settings stay in YAML and the existing Server settings panel. The wizard asks only what cannot be worked out automatically.

## Lifecycle

1. `server/index.js` resolves the config path as it does today (`--config`, otherwise the default).
2. **If the file does not exist**, start setup mode (D1). If it exists but is invalid, fail with the current error, as today. A broken config must never fall back silently to an unauthenticated setup page.
3. Setup mode generates a setup code, prints it with the setup URL to the console and the log, and listens.
4. When the owner finishes, setup writes the config, closes the setup listener and **starts the normal app in the same process** on the same port (D6). This works the same under the Windows scheduled task, a double-clicked launcher and Docker's restart policy, because nothing depends on a supervisor restarting the process.
5. With a config present, setup mode never starts and every `/setup` route returns 404. To redo setup, stop uburoom and move the config away (documented; there's no in-app reset).

## Where the config lives (D4)

Today the default is `config.yaml` beside the code. For an installed product, the code folder gets replaced on update, so I propose:

- **Default config path:** a per-user data folder outside the code (`%LOCALAPPDATA%\uburoom\config.yaml` on Windows, `~/.config/uburoom/config.yaml` elsewhere), with `storage.data_directory` defaulting beside it. That matches the credential key, which already defaults outside the project.
- **Docker:** mount a **directory**, not a single file: `./config:/config`, with `CMD ["node", "server/index.js", "--config", "/config/config.yaml"]`. That fixes two problems at once. The current `:ro` single-file mount breaks Server settings saves. And even a writable single-file bind mount breaks the config editor's atomic `rename`, which can't replace a bind-mounted file.
- An existing `config.yaml` beside the code still works through `--config`. Since this is prerelease, there is no automatic migration; Vigrid's launcher passes `--config` explicitly.

## Transport during setup (D2)

| Bound to | Setup page served as | Why |
| --- | --- | --- |
| Loopback (default for the Windows install) | `http://localhost:5756/setup` | Browsers treat `http://localhost` as a secure context, so there's no certificate warning on the first screen and nothing goes over the network. |
| Any other interface (Docker, NAS, `--setup-host 0.0.0.0`) | HTTPS with a self-signed certificate generated into the data folder | The setup code and session cookie cross the LAN, so they get TLS. The one-time warning is accepted for now. |

Binding beyond loopback in setup mode needs an explicit command-line flag (`--setup-host`), not an environment variable, in line with the no-env-overrides rule. The Docker image passes it in its `CMD`.

Certificate generation moves out of `scripts/new-dev-cert.js` into a server module (for example `server/local-tls.js`) used by both the script and setup. Setup also uses it for the certificate the finished install runs on (see step 5).

## Security of setup mode

- **Setup code:** 128 random bits shown as grouped base32 (`ABCD-EFGH-…`). A new code is made each time setup mode starts; the server keeps only its hash; comparison is constant-time.
- **Attempts:** after 10 wrong codes, the current code is invalidated and a new one goes to the console and log. That bounds guessing without locking the owner out.
- **Session:** a correct code is exchanged for a random setup session in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` on HTTPS), valid for 30 minutes. Only one active setup session at a time; a new code exchange ends the old session.
- **Request checks:** every state-changing request must have a matching `Origin`. The `Host` header must be `localhost`, a literal IP or the name in the generated certificate, which blocks DNS-rebinding pages from driving a loopback setup server.
- **Handing over the code without typing:** the console shows `…/setup#code=ABCD-…`. The fragment never reaches the server or logs, and the page reads it and submits it. A future Windows launcher can open that URL directly (D8).
- **What setup can do:** only create a config that doesn't exist (`wx` open, with the same private-file permissions and link checks as `server/config-editor.js`). It can't read or overwrite an existing config, and the response never includes tokens.

## Wizard steps

The pages follow the [design guide](design-guide.md). Screen layout and wording are UI decisions that need approval before the build.

### 1. Setup code

Filled in automatically from the URL fragment, otherwise typed. One line explains where to find it (console window, `docker logs uburoom`).

### 2. Your account

"Sign in with Plex" (the plex.tv PIN flow, with the account step split out of `server/plex-auth.js` so it needs no configured server) or "Create a uburoom account" (username and a password of at least 10 characters). The result becomes the server operator. Tokens and passwords stay on the server.

### 3. Media sources

A list of added sources, each with **Edit** (rename, switch libraries on or off) and remove buttons, and three add buttons: **Add Plex**, **Add Jellyfin**, **Add a folder**. Next is enabled once at least one source is added. Each add flow is the source module's `connect` ([media sources](media-sources.md)):

- **Plex:** uses the Plex sign-in from step 2, or asks for one. Lists the account's servers; tests each server's connections from the uburoom machine (local first, never relay) against its `/identity`; unreachable servers are shown disabled with the reason. A manual address field is the fallback. The account does not have to own the server.
- **Jellyfin:** lists servers found on the network, with a manual address field. Then a Jellyfin administrator signs in once, with username and password or the Quick Connect code shown; uburoom creates its own API key and keeps no password. Last, pick the Jellyfin user whose libraries are offered.
- **Libraries (owner request, 2026-11-21):** adding or editing a Plex or Jellyfin source shows its libraries with on/off checkboxes and item counts, saved as the source's `libraries:` list. Libraries added to that server later start off.
- **Folders:** a folder browser listing directories on the uburoom machine (setup-session only; in Docker, the container's mounted paths). Then a name and Movies or Shows.

### 4. Who can get in

One checkbox per entry rule, with a one-line hint each:

| Rule | Default |
| --- | --- |
| People with access to each Plex source / an account on each Jellyfin source (one row per source) | On |
| Anyone who knows the server password (shows a password field when ticked) | Off |
| uburoom accounts you create | On |
| Guests with a room invite | On |
| Members of your Discord servers. Setup shows the OAuth2 redirect, bot credentials and joined servers. Uncheck a server to exclude it. Servers with more than 500 members show a warning. | Off |

### 5. Where will people watch?

| Choice | Writes | Certificate |
| --- | --- | --- |
| This computer | `server.host: '127.0.0.1'`, `public_url: https://localhost:5756` | Self-signed for `localhost` |
| My home network | `server.host: '0.0.0.0'`, `public_url` set to the detected LAN address | Self-signed covering `localhost` and that address; the page says viewers will see a one-time warning |

A **Port** field defaults to the setup listener's port (normally 5756) and sets `server.port`. With Docker, the field shows the fixed container port and setup uses the address and published port from the browser. Open setup by the Docker host's LAN IP to choose **My home network**. Certificates go in the data folder, and their paths are written to `server.tls_cert` and `server.tls_key`.

### 6. Check and finish

- Run the doctor checks in-process against the proposed config: port, every media source's `check`, certificate, settings and data folder, encryption key (with a back-up reminder). `scripts/doctor.js` already has `runDoctor(options)`; the checks get a function form that takes a config object.
- Show pass or fix for each. Finish is enabled only when all pass.
- Write the config from `config.example.yaml` as the template, using the `yaml` library's document API so comments stay, and validate it with `normalizeConfig` before writing.

### 7. Ready, already signed in

"uburoom is ready. You're signed in." On Finish, setup creates a single-use ticket (about a minute) bound to the setup session. **Open uburoom** submits it by form POST to the new app, which hands the already-verified identity to the same sign-in completion code a normal sign-in uses, sets the normal session and opens the lobby. No second sign-in, and no setup-only account path.

### Mockup

`personal/mockups/first-run-setup.html` (served by `personal/mockups/serve.js`; v1 kept as `first-run-setup-v1.html`). Screen and wording choices for steps 2–7 were made by the coordinator under the owner's delegated discretion on 2026-11-20 and are open to owner changes.

## The fallback default (separate small change)

Flip `plex.fallback_enabled` to `false` in `config.example.yaml`, `server/config.js` and the doctor, and update the README and self-hosting text. Prerelease, so there's no compatibility handling. Vigrid's private config sets the value explicitly if the owner wants it kept on. This can ship before the wizard.

## Code changes (expected)

| Area | Change |
| --- | --- |
| `server/index.js` | Choose setup or normal mode; in-process handoff |
| `server/setup/` (new) | Setup server, code and session, Plex discovery, config writer |
| `web/setup/` (new) | Wizard page (native modules, no framework) |
| `server/plex-auth.js` | Split account sign-in from server validation |
| `server/local-tls.js` (new) | Certificate generation, shared with `scripts/new-dev-cert.js` |
| `server/config.js` | New default config location; fallback default |
| `server/config-editor.js` | Export the private write and permission helpers for setup's create-only write |
| `scripts/doctor.js` | Checks callable against a config object |
| `Dockerfile`, `docker-compose.yml`, `docs/docker.md` | Directory config mount, `--setup-host`, no `:ro` on config |
| `README.md`, `docs/self-hosting.md` | Install → open setup page as the main path; YAML as the advanced reference |

## Tests

Focused regression tests for the boundaries that matter:

- No setup route works without a valid code; after 10 wrong attempts the code changes.
- A request with a wrong `Origin` or a foreign `Host` is refused.
- Setup never overwrites an existing config, and every `/setup` route is 404 once one exists.
- The generated config passes `normalizeConfig` and the doctor; `operator.plex_id` matches the signed-in account; fallback is off unless chosen.
- No setup response contains a Plex token.
- The handoff serves `/health` from the normal app on the same port.

The end-to-end wizard can run against the fake Plex in `uburoom-demo`. Whether that becomes a permanent smoke runner needs owner approval, per the repo rules.

## Out of scope

- Jellyfin, local libraries and Discord in the wizard (YAML for now; could be added as later steps).
- Trusted certificates for internet access, and plain-HTTP operation behind a trusted proxy. That's the next design.
- The Windows installer and a published Docker image (publication needs owner authorization).
- A dedicated fallback account during setup.

## Approved decisions (2026-11-20)

- **D1:** Setup starts only when the config file is missing, not when it's incomplete.
- **D2:** Plain HTTP on loopback, self-signed HTTPS when bound wider.
- **D3:** Ownership = setup code from the console/log + Plex sign-in writes `operator.plex_id`.
- **D4:** Default config moves to a per-user data folder outside the code; Docker mounts a config directory. (2026-11-21: the per-user default is withdrawn by the owner; the default stays beside the code. Docker's `/config` stands.)
- **D5:** `plex.fallback_enabled` defaults to `false`; setup asks.
- **D6:** In-process handoff from setup to the normal app, not exit-and-restart.
- **D7:** v1 requires the Plex account to own the chosen server (simplest, and `directory.expose_plex_members` needs the owner token). Non-owner accounts can come later.
- **D8:** The console prints a URL with the code in the fragment, so the launcher or user can open it without typing.

## Mockup approval (2026-11-21)

The owner approved the revised mockup (`personal/mockups/first-run-setup.html`), with two changes made before approval: the step 6 check marks line up with their titles, and step 4's Discord rule admits members of any server the bot has joined rather than one picked server. The any-server change touches Discord membership, commands, events and sharing beyond setup, so it is its own piece of work ahead of or alongside phase 7; the wizard's step 4 is built against it.

## Implementation notes (2026-11-21)

Where the build differs from the text above, or decides something it left open. Code: `server/setup/`, `server/start.js`, `server/http/setup-handoff.js`, `web/setup/`, `web/styles/setup.css`; tests: `tests/setup.test.js`.

- **Default config location (D4) unchanged.** The default stays `config.yaml` beside the code. `run-uburoom.bat` and Vigrid's scheduled task pass no `--config`, so moving the default would start setup mode on Vigrid after an update. The owner decided on 2026-11-21 to keep it there; D4's first bullet is withdrawn. Docker still uses `/config`.
- **Setup's own certificate** (when bound beyond loopback) is made in memory each time setup starts and never written. The installation's certificate goes in `data/certs/` and its paths are written as `data/certs/server-cert.pem` and `data/certs/server-key.pem`.
- **Hand-off link instead of a form POST.** Open uburoom goes to `<public_url>/auth/setup#ticket=…`; that page posts the ticket from the app's own origin. A form POST does not survive the browser's certificate warning for the new self-signed certificate, and the fragment never reaches a log. The ticket is single-use and lasts two minutes. A uburoom account is created when the app starts, so it exists even if the link is never used.
- **The operator's own way in stays on (step 4).** Admission does not let the operator in by being the operator, so the rule that admits the operator's account cannot be turned off: "uburoom accounts you create" for a uburoom account, or the Plex source when there is one (checkbox shown on and disabled, "Your account gets in this way."). With several Plex sources, at least one must stay on. A Plex operator with no Plex source is asked to add one or use a uburoom account.
- **Server password:** at least 8 characters.
- **Discord (step 4):** setup verifies the pasted Application ID, client secret and bot token with Discord and records the application's owner or team's owner in `discord.owner_id`. The joined server list refreshes when the page regains focus. Servers that the operator unchecks go into `discord.excluded_guild_ids`. The redirect uses `/auth/callback`.
- **Discord (step 6):** use the final URL shown under Check and finish to update OAuth2 Redirects in the Developer Portal, especially if the address or port changed. Setup's local checks do not validate the registered redirect. The implemented wizard awaits owner acceptance.
- **Step 6 media sources** uses each source module's connection check (an unreachable server is a fix, not a warning) and then its full check (a failure is a fix).
- **Existing data:** a uburoom account from setup needs a data folder without a database; with existing data, step 6 asks to move it aside or sign in with Plex.
- **Remote access guide:** named as `docs/remote-access.md` in the uburoom folder; there is no published address to link to.
- **The setup code** is 26 characters (seven groups); the field's text shrinks to fit narrow screens.

