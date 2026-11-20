# First-run setup

**Status: design approved by the owner on 2026-11-20 (D1–D8 as recommended). Implemented so far: the fallback default (D5) and the Docker config folder (part of D4). Setup mode itself is not implemented.**

**Being revised:** the [media sources and admission](media-sources.md) proposal replaces the Plex-only parts of this design. When it's approved, the Sharing step (and D5's setup question) goes away, Connect Plex and Choose your server become one connector in a "Media sources" step that can add any number of Plex, Jellyfin and folder sources, D7 (Plex account must own the server) is reconsidered, a "Who can get in" step picks the entry rules (Discord server, members of a chosen source, server password, uburoom accounts, room invites), and the owner signs in with Plex or creates a uburoom account. The setup code, transport, config location and hand-off decisions stay as they are. The wizard's screen layout and wording still need UI approval before the build.

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

### 2. Connect Plex

- "Sign in with Plex" uses the existing PIN flow in `server/plex-auth.js`. `start()` already works without a configured server. `finish()` currently calls `validate()`, which needs a configured Plex server, so the plex.tv account step (PIN → token → `/user`) gets split out into its own function, and both normal sign-in and setup use it.
- The server keeps the token in setup memory only, never in the browser.

### 3. Choose your server

- Fetch `/resources?includeHttps=1` from plex.tv with that token and list entries that provide `server` and are **owned** by the account (D7).
- For the chosen server, test its connections **from the uburoom machine**: local addresses first, then remote, never relay. Ask each for `/identity`, and pick the first that answers with the expected `machineIdentifier`. If none answers, say so plainly ("uburoom can't reach this server from this computer") and offer a manual URL field.
- Result: `plex.url`, `plex.token` and `plex.machine_identifier`.

### 4. Sharing

One plain-language question, defaulting to **No** (D5):

> **Let friends watch even if they don't have access to your Plex server?** If yes, uburoom plays media for them using your Plex account, so they can see anything your account can. You can change this later.

"Yes" sets `plex.fallback_enabled: true` with the owner's token, and the existing startup warning stays. Using a dedicated fallback account (a second PIN sign-in) is a follow-up, not v1.

### 5. Who will connect

| Choice | Writes | Certificate |
| --- | --- | --- |
| Just this computer | `server.host: '127.0.0.1'`, `public_url: https://localhost:5756` | Self-signed for `localhost` |
| People on my home network | `server.host: '0.0.0.0'`, `public_url` set to the detected LAN address | Self-signed covering `localhost` and that address; the page says viewers will see a one-time warning |
| People over the internet | Not offered in v1; links to the remote-access guide | Depends on the TLS decision |

Certificates go in the data folder, and their paths are written to `server.tls_cert` and `server.tls_key`.

### 6. Check and finish

- Run the existing doctor checks in-process, against the proposed config: port, storage and key location, TLS files, Plex connectivity. `scripts/doctor.js` already has `runDoctor(options)`, and the checks get a function form that takes a config object instead of reading a file.
- Show the results as pass or fix. "Finish" is enabled only when all of them pass.
- Write the config from `config.example.yaml` as the template, using the `yaml` library's document API so comments stay. Validate it with `normalizeConfig` before writing. The signed-in Plex account's ID goes into `operator.plex_id`.
- Hand off to the normal app and redirect to `/watch`. The owner signs in with Plex through the normal flow, which creates their account; they're recognized as operator through `operator.plex_id`. No setup-only account path.

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
- **D4:** Default config moves to a per-user data folder outside the code; Docker mounts a config directory.
- **D5:** `plex.fallback_enabled` defaults to `false`; setup asks.
- **D6:** In-process handoff from setup to the normal app, not exit-and-restart.
- **D7:** v1 requires the Plex account to own the chosen server (simplest, and `directory.expose_plex_members` needs the owner token). Non-owner accounts can come later.
- **D8:** The console prints a URL with the code in the fragment, so the launcher or user can open it without typing.
