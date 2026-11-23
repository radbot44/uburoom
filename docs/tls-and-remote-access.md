# TLS and remote access

**Status: approved by the owner on 2026-11-21 (T1–T7 as recommended) and built:** `server.listen: 'http-proxy'` (T1–T5), the Docker health check (T6), the [remote access guide](remote-access.md), the setup wizard's internet-access option (T7), and optional direct LAN access (`server.lan_url`, including `'auto'` and one-time Discord/Plex OAuth handoff). Plain HTTP on the LAN stays forbidden (T5): browsers treat a non-HTTPS LAN address as an insecure context, which breaks uburoom's `Secure` sign-in cookies and features such as Document Picture-in-Picture and the clipboard, and it would send session cookies and passwords in clear.

## Problem

uburoom always serves its own HTTPS listener (`server/http/server.js` calls `https.createServer`; `server/index.js` reads `server.tls_cert` and `server.tls_key` unconditionally). Everything a person would use to reach it from the internet already terminates TLS with a trusted certificate: Cloudflare Tunnel, Tailscale, Caddy, nginx. So today:

- A reverse proxy or tunnel must connect to uburoom over HTTPS and **skip certificate checks** against a self-signed certificate (the Caddy recipe in [docker.md](docker.md) uses `tls_insecure_skip_verify`). That is awkward, and it teaches readers to turn verification off.
- An owner must make a certificate even when the proxy next to uburoom, on the same host or Docker network, makes it pointless.
- It blocks the easy remote-access routes that [first-run setup](first-run-setup.md) leaves for "the next design".

What does not change: `server.public_url` stays a required HTTPS origin. Browsers, cookies, Discord, WebSocket origin checks and `Secure` cookies all see HTTPS. Only the hop between the trusted proxy and uburoom changes.

## What the code does today (relevant facts)

- Cookies are always `HttpOnly; Secure; SameSite=Lax` (`server/http/sessions.js`, `server/watch-http.js`). That is correct when the browser talks HTTPS to the proxy; uburoom does not look at its own socket to decide.
- Absolute URLs, CSRF and WebSocket origin checks compare against `config.publicUrl`, not the `Host` header or the socket (`server/watch-socket.js`, `server/http/auth.js`, `server/watch-http.js`). Plain HTTP behind a proxy needs no change there.
- `Strict-Transport-Security` is set on every response. Browsers only honor it from the HTTPS side, so it is harmless on the plain hop.
- The client address comes from `server/client-address.js`: the socket peer, replaced by the forwarding header only when the peer is in `server.trusted_proxies`. With `trusted_proxies: []`, every viewer behind a proxy looks like one address (the proxy), which breaks rate limits and the LAN-versus-WAN delivery choice.
- `/health` is a plain route with no auth. The Docker `HEALTHCHECK` calls it over HTTPS with `rejectUnauthorized: false`.

## Decisions

### T1. Allow plain HTTP only for a trusted local proxy

**Recommend: yes, as an explicit opt-in.** Add one setting, `server.listen`, with values `https` (default, today's behavior) and `http-proxy`. In `http-proxy` mode uburoom starts `http.createServer` instead of `https.createServer`. It does not read `tls_cert` and `tls_key` (the doctor warns if they are set), so no certificate is needed.

Why an explicit mode and not "blank `tls_cert` means HTTP": a missing or misspelled path must keep failing loudly. Silently dropping to HTTP is the dangerous failure.

Alternative: keep HTTPS-only and generate a self-signed certificate automatically. That keeps `tls_insecure_skip_verify` in every proxy recipe, so it only helps the first install.

### T2. Who may connect in `http-proxy` mode

**Recommend: refuse everyone except configured proxies, per connection.**

- `server.trusted_proxies` must be non-empty (startup fails otherwise, with a message that says why). It is the single list of who may speak plain HTTP and whose forwarding header is believed.
- A connection whose peer address is not in that list is destroyed on `connection`, before any request is parsed. WebSocket upgrades arrive on the same server, so one check covers both.
- **Exception:** `GET /health` from a loopback peer is always answered, so the Docker health check and local scripts work without listing `127.0.0.1` as a trusted proxy.
- Binding: `server.host` may be loopback, a private address or `0.0.0.0` (needed in a container), because the peer check, not the bind address, is the control. The doctor warns when `http-proxy` is combined with a non-loopback bind outside a container.
- `server.trusted_proxy_header` must match what the proxy sends (`cf-connecting-ip` for Cloudflare; `x-forwarded-for` for Caddy and Tailscale).

Caveat to document: when Docker publishes a port with `ports:`, traffic from outside can arrive with the bridge gateway as its peer address, which would fall inside a broad CIDR such as `172.16.0.0/12`. The guide therefore says: **in `http-proxy` mode do not publish the port**. Use `expose:` or `127.0.0.1:5756:5756`, and list the narrowest range that holds the proxy container (a Compose network with a fixed subnet).

### T3. Require proof the browser used HTTPS

**Recommend: yes.** Even from a trusted peer, reject (421) any request that lacks `X-Forwarded-Proto: https`, except `/health`. This catches a proxy set up to publish plain HTTP, which would otherwise hand `Secure` cookies to a browser that never keeps them and fail as a confusing login loop. Cloudflare Tunnel, Caddy and `tailscale serve` all send the header; nginx needs `proxy_set_header X-Forwarded-Proto $scheme;`. The error message names the missing header.

Alternative: skip the check and rely on `public_url` being HTTPS. Simpler, but misconfiguration shows up as a login loop.

### T4. `public_url` stays HTTPS and required

**Recommend: unchanged, enforced in both modes.** The config validator already rejects a non-HTTPS `public_url` (`server/config.js`). `http-proxy` must not weaken it. The doctor should also warn when `http-proxy` is on and the `public_url` host is `localhost` (a tunnel pointing at localhost is a mistake unless testing).

### T5. What stays forbidden

**Recommend: write these into this doc and the validator.**

- Plain HTTP to anyone but a configured proxy (T2). No "allow HTTP on the LAN" switch: Plex tokens, session cookies and the setup code would cross the network in clear.
- `http-proxy` without `trusted_proxies`.
- A non-HTTPS `public_url`.
- Dropping the `Secure` flag on cookies. They stay `Secure`.

### T6. Docker and the health check

**Recommend:** keep `https` as the image default so existing installs behave the same. Make the `HEALTHCHECK` read the configured mode and use `http` or `https` (it already loads the config to find the port). The remote-access Compose files set `server.listen: 'http-proxy'`, `server.host: '0.0.0.0'` and a `trusted_proxies` CIDR matching a Compose network defined in the same file. The Caddy recipe in docker.md becomes `reverse_proxy uburoom:5756` with no `tls_insecure_skip_verify`.

### T7. Setup wizard

**Built:** Step 5 ("Where will people watch?") offers **This computer**, **My home network** (which also enables `server.lan_url: 'auto'` on bare-metal installs and adds the machine's hostname to the local certificate), and **The internet**. Picking **The internet** lets the operator enter `server.public_url` and pick Cloudflare Tunnel, Tailscale, Caddy/proxy (`server.listen: 'http-proxy'`, `trusted_proxies`, `trusted_proxy_header`), or Direct HTTPS (with an optional `server.lan_url: 'auto'` toggle for direct LAN access).

### Direct LAN access (`server.lan_url`)

Operators who want direct HTTPS LAN access alongside `server.public_url` can set `server.lan_url` to `'auto'` (in `server.listen: 'https'` mode, trusting this machine's detected private IPs, hostname, and loopback on `server.port` for local-network peers) or to an explicit HTTPS origin (for Docker or a local HTTPS reverse proxy). Plain HTTP on the LAN remains forbidden (T5). Discord and Plex sign-in and account linking bounce through `server.public_url`'s single registered callback and return to the LAN origin via a single-use, host-nonce-bound fragment ticket (`/auth/lan#ticket=…`). See [remote access](remote-access.md) for usage and `node scripts/new-dev-cert.js --lan` for LAN certificate SANs.

### Implementation sketch (if approved)

`server/config.js` (new `server.listen`, validation for T2/T4), `server/http/server.js` (HTTP server, peer check, proto check), `server/index.js` (skip reading certificates), `scripts/doctor.js`, `config.example.yaml`, the `Dockerfile` health check, `docs/docker.md`, `docs/self-hosting.md`. Focused tests: untrusted peer destroyed; trusted peer without `X-Forwarded-Proto` gets 421; `/health` from loopback works; WebSocket upgrade from an untrusted peer refused; startup fails with `http-proxy` and empty `trusted_proxies`.

---

The remote access guide that was drafted here is now [remote access](remote-access.md).
