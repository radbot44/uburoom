# TLS and remote access

**Status: approved by the owner on 2026-11-21 (T1–T7 as recommended). Not built yet.** The [remote access guide](#remote-access-guide-draft) at the end becomes true once T1 is implemented. Plain HTTP on the LAN stays forbidden (T5): browsers treat a non-HTTPS LAN address as an insecure context, which breaks uburoom's `Secure` sign-in cookies and features such as Document Picture-in-Picture and the clipboard, and it would send session cookies and passwords in clear.

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

**Recommend:** the wizard does not offer internet access in v1 (as [first-run-setup.md](first-run-setup.md) says). Once T1 exists, a later "Reach it from the internet" step can pick a route from the guide below and write `server.listen`, `public_url`, `trusted_proxies` and the header. Until then the guide is the only path.

### Implementation sketch (if approved)

`server/config.js` (new `server.listen`, validation for T2/T4), `server/http/server.js` (HTTP server, peer check, proto check), `server/index.js` (skip reading certificates), `scripts/doctor.js`, `config.example.yaml`, the `Dockerfile` health check, `docs/docker.md`, `docs/self-hosting.md`. Focused tests: untrusted peer destroyed; trusted peer without `X-Forwarded-Proto` gets 421; `/health` from loopback works; WebSocket upgrade from an untrusted peer refused; startup fails with `http-proxy` and empty `trusted_proxies`.

---

## Remote access guide (draft)

Goal: friends outside your home open `https://watch.example.com` and join your rooms. Pick one route.

| Route | Who can join | Needs | Notes |
| --- | --- | --- | --- |
| **Cloudflare Tunnel** (recommended) | Anyone with the link | A domain on Cloudflare (free plan works) | No port forwarding, works behind CGNAT, trusted certificate. Read the [video caveat](#caveat-about-cloudflare-and-video). |
| **Tailscale** | Only people you invite to your tailnet | Everyone installs Tailscale | Private. Not usable for Discord Activities (Discord cannot reach a tailnet). |
| **Own domain + Caddy** | Anyone with the link | A domain, ports 80 and 443 forwarded, a public IP (no CGNAT) | Most control, no third party in the path. |

Before you start: uburoom runs, `npm run doctor` passes, and your media source works on the local network.

### Route 1: Cloudflare Tunnel

1. **Domain.** Add your domain to Cloudflare (Websites → Add a site) and move its nameservers there. Pick a hostname, for example `watch.example.com`.
2. **Create the tunnel.** In the Cloudflare dashboard open Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared. Name it `uburoom`. Copy the **tunnel token** it shows (a long string). Menu names change; the token is what you need.
3. **Public hostname.** In the tunnel's Public Hostname tab add `watch.example.com`, service type `HTTP`, URL `uburoom:5756`. Use HTTP, not HTTPS; that is the point of T1. Cloudflare creates the DNS record for you.
4. **uburoom config** (`config/config.yaml`):

   ```yaml
   server:
     listen: 'http-proxy'
     host: '0.0.0.0'
     port: 5756
     public_url: 'https://watch.example.com'
     trusted_proxies: ['172.30.0.0/24'] # the Compose network below
     trusted_proxy_header: 'cf-connecting-ip'
   ```

5. **Compose** (`docker-compose.yml`). Only the tunnel token is left for you. uburoom has no `ports:`.

   ```yaml
   services:
     uburoom:
       build: .
       container_name: uburoom
       restart: unless-stopped
       stop_grace_period: 45s
       expose:
         - "5756"
       volumes:
         - ./config:/config
         - ./secrets:/var/lib/uburoom
       networks:
         - edge

     cloudflared:
       image: cloudflare/cloudflared:latest
       container_name: uburoom-tunnel
       restart: unless-stopped
       command: tunnel --no-autoupdate run
       environment:
         TUNNEL_TOKEN: "" # paste the tunnel token from step 2
       depends_on:
         - uburoom
       networks:
         - edge

   networks:
     edge:
       ipam:
         config:
           - subnet: 172.30.0.0/24
   ```

   Keep the token private; anyone holding it can run your tunnel. Do not commit this file with the token in it.
6. **Discord (optional).** For Discord login or an Activity, set the redirect URI and the Activity URL mapping in the Discord developer portal to `https://watch.example.com`.
7. **Start and verify.**

   ```sh
   docker compose up -d
   docker compose logs cloudflared   # look for "Registered tunnel connection"
   curl https://watch.example.com/health
   ```

   `/health` should answer `{"ok":true,...}` with no certificate warning. Then open `https://watch.example.com/watch` on a phone using mobile data (not your home Wi-Fi), sign in, create a room and play something. If it fails, read `docker compose logs uburoom`.

Without Docker: run `cloudflared` on the same machine, point the public hostname at `http://localhost:5756`, and use `host: '127.0.0.1'` and `trusted_proxies: ['127.0.0.1', '::1']`.

#### Caveat about Cloudflare and video

Cloudflare's terms restrict serving large amounts of video through its network, and a watch party streams video. Whether your use is allowed depends on your plan and on the terms as they stand today, and the terms change. Read Cloudflare's current terms yourself before relying on this route for regular use. If you are unsure, use Tailscale or your own domain with Caddy.

### Route 2: Tailscale (private group)

1. Install Tailscale on the uburoom host and on every viewer's device, and invite viewers to your tailnet (admin console → Users). Turn on HTTPS certificates in the admin console's DNS settings.
2. Note the host's name, such as `media.tail1234.ts.net`.
3. Set in `config.yaml`:

   ```yaml
   server:
     listen: 'http-proxy'
     host: '127.0.0.1'
     public_url: 'https://media.tail1234.ts.net'
     trusted_proxies: ['127.0.0.1', '::1']
     trusted_proxy_header: 'x-forwarded-for'
   ```

4. On the host run `tailscale serve --bg --https=443 http://127.0.0.1:5756`. Do **not** use `tailscale funnel`; that publishes to the whole internet.
5. Verify from a device on the tailnet: `https://media.tail1234.ts.net/health`, then `/watch`. A device without Tailscale must fail to connect.

### Route 3: Your own domain and Caddy

1. Point `watch.example.com` at your public IP (an A record) and forward TCP 80 and 443 from the router to the Caddy machine. If your ISP gives you no public IPv4 address (CGNAT), use Cloudflare Tunnel or Tailscale instead.
2. In the Compose file from [docker.md](docker.md), change uburoom to `expose` only, set `server.listen: 'http-proxy'`, and put both services on a fixed-subnet network as in Route 1.
3. `Caddyfile`:

   ```caddy
   watch.example.com {
       reverse_proxy uburoom:5756
   }
   ```

   Caddy gets a trusted certificate by itself, sends `X-Forwarded-For` and `X-Forwarded-Proto`, and passes WebSockets without extra settings. Set `trusted_proxy_header: 'x-forwarded-for'` and `trusted_proxies` to the Compose subnet.
4. `docker compose up -d`, then check `https://watch.example.com/health` from outside your network.

### If it does not work

| Symptom | Likely cause |
| --- | --- |
| 421 or "missing X-Forwarded-Proto" | The proxy is publishing plain HTTP or does not send the header (T3). |
| Connection reset from the proxy | The proxy's address is not in `trusted_proxies` (T2). |
| Everyone shows the same address, rate limits trip early | `trusted_proxy_header` does not match what the proxy sends. |
| Login loops | `public_url` differs from the address in the browser (scheme, host or port). |
| Room connects then drops | The proxy does not pass WebSocket upgrades on `/watch-socket`. |
