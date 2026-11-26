# Remote access

Friends outside your home open `https://watch.example.com` and join your rooms. uburoom sits behind a tunnel or proxy that serves that address over HTTPS with a trusted certificate, and talks plain HTTP only to it (`server.listen: 'http-proxy'`). Why it works this way, and what stays forbidden, is in [TLS and remote access](tls-and-remote-access.md).

In `http-proxy` mode:

- Only addresses in `server.trusted_proxies` may connect (it must not be empty). Other connections are dropped before a request is read; `GET /health` from the same machine is always answered, for health checks.
- The proxy must send `X-Forwarded-Proto: https`; requests without it get 421. Cloudflare Tunnel, Caddy, `tailscale funnel` and `tailscale serve` send it.
- `server.public_url` stays the HTTPS address people open, sign-in cookies stay `Secure`, and no certificate is read.
- Plain HTTP on your LAN is not offered: a browser on `http://` would lose sign-in and Picture-in-Picture, and passwords would cross the network in clear.
- With Docker, do not publish uburoom's port (`ports:`): traffic from outside can then arrive from the bridge gateway, inside a broad CIDR. Use `expose:` and list the narrowest subnet that holds the proxy, as in the Compose files below.

Pick one route.

| Route | Who can join | Needs | Notes |
| --- | --- | --- | --- |
| **Tailscale Funnel** (easiest) | Anyone with the link | Tailscale on the host only (free plan works, no domain needed) | No port forwarding, works behind CGNAT, trusted certificate, friends do not install Tailscale. Auto-detected in setup Step 5. |
| **Cloudflare Tunnel** | Anyone with the link | A domain on Cloudflare (free plan works) | No port forwarding, works behind CGNAT, trusted certificate. Read the [video caveat](#caveat-about-cloudflare-and-video). |
| **Tailscale Serve** | Only people you invite to your tailnet | Everyone installs Tailscale | Private. Not usable for Discord Activities (Discord cannot reach a tailnet). |
| **Own domain + Caddy** | Anyone with the link | A domain, ports 80 and 443 forwarded, a public IP (no CGNAT) | Most control, no third party in the path. |

Before you start: uburoom runs, `npm run doctor` passes, and your media source works on the local network.

## Route 1: Cloudflare Tunnel

1. **Domain.** Add your domain to Cloudflare (Websites → Add a site) and move its nameservers there. Pick a hostname, for example `watch.example.com`.
2. **Create the tunnel.** In the Cloudflare dashboard open Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared. Name it `uburoom`. Copy the **tunnel token** it shows (a long string). Menu names change; the token is what you need.
3. **Public hostname.** In the tunnel's Public Hostname tab add `watch.example.com`, service type `HTTP`, URL `uburoom:5756`. Use HTTP, not HTTPS: the tunnel already encrypts everything between the browser and your machine, and uburoom only accepts plain HTTP from the proxies you list. Cloudflare creates the DNS record for you.
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

   `/health` should answer `{"ok":true,...}` with no certificate warning. Reaching `https://watch.example.com` from the setup computer only confirms proxy handoff—actual external WAN reachability still requires opening `https://watch.example.com/watch` from outside your home network (for example, on a phone using mobile data with Wi-Fi off), signing in, creating a room, and playing something. If it fails, read `docker compose logs uburoom`.

Without Docker: run `cloudflared` on the same machine, point the public hostname at `http://localhost:5756`, and use `host: '127.0.0.1'` and `trusted_proxies: ['127.0.0.1', '::1']`.

### Caveat about Cloudflare and video

Cloudflare's terms restrict serving large amounts of video through its network, and a watch party streams video. Whether your use is allowed depends on your plan and on the terms as they stand today, and the terms change. Read Cloudflare's current terms yourself before relying on this route for regular use. If you are unsure, use Tailscale or your own domain with Caddy.

## Route 2: Tailscale

Tailscale supports two modes with uburoom—**Funnel** for friends over the internet (no Tailscale needed on their device), or **Serve** for a private tailnet only.

### Tailscale Funnel (friends over the internet — simplest)

1. Install Tailscale on the uburoom host and sign in. In the Tailscale admin console, make sure **MagicDNS**, **HTTPS Certificates**, and **Funnel** are enabled for this device.
2. **In first-run setup (Step 5):** choose **The internet** → **Tailscale**. uburoom automatically detects your `https://<host>.<tailnet>.ts.net` address, fills in the Public HTTPS address, and offers **Enable Tailscale Funnel on this port** (which runs `tailscale funnel --bg <port>` for you, or shows the exact command to paste if your tailnet ACL or OS permissions require running it in a terminal).
3. **Or configure `config.yaml` manually:**

   ```yaml
   server:
     listen: 'http-proxy'
     host: '127.0.0.1'
     port: 5756
     public_url: 'https://media.tail1234.ts.net'
     trusted_proxies: ['127.0.0.1', '::1']
     trusted_proxy_header: 'x-forwarded-for'
   ```

   Then run one command on the host:

   ```sh
   tailscale funnel --bg 5756
   ```

4. **Verify.** Step 7 of setup checks `https://media.tail1234.ts.net/health` automatically once uburoom finishes starting. Confirm external reachability by opening `https://media.tail1234.ts.net/watch` from outside your home network (for example, on a phone using mobile data with Wi-Fi off).

> [!NOTE]
> Funnel publishes your `*.ts.net` address to the internet so friends can join without installing Tailscale. Keep your uburoom access rules (Step 4 / `access:` in `config.yaml`) set to allow only the people you intend. To stop Funnel later, run `tailscale funnel --https=443 off`.

### Tailscale Serve (private tailnet only)

If you want only people invited to your tailnet to be able to reach the server at all:

1. Install Tailscale on the uburoom host and on every viewer's device, invite viewers to your tailnet (admin console → Users), and turn on HTTPS certificates in DNS settings.
2. Use the same `config.yaml` settings as above (`listen: 'http-proxy'`, `host: '127.0.0.1'`, `public_url: 'https://media.tail1234.ts.net'`, `trusted_proxies: ['127.0.0.1', '::1']`, `trusted_proxy_header: 'x-forwarded-for'`).
3. On the host run `tailscale serve --bg --https=443 http://127.0.0.1:5756` (do not run `tailscale funnel`).
4. Verify from a device on the tailnet: `https://media.tail1234.ts.net/health`, then `/watch`. A device without Tailscale will not be able to connect.

## Route 3: Your own domain and Caddy

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

## Direct LAN access alongside remote access (optional)

If you want devices at home to reach uburoom directly on the LAN (keeping local playback off your internet connection or tunnel) while remote friends keep using `server.public_url`, set `server.lan_url` in `config.yaml`:

- **Bare-metal installs (`server.listen: 'https'`):** Set `server.lan_url: 'auto'` and `server.host: '0.0.0.0'`. uburoom trusts this machine's detected private IP(s) and hostname on `server.port` (for example `https://192.168.1.10:5756` and `https://myserver:5756`) for local-network peers.
- **Docker or a local HTTPS reverse proxy:** Set `server.lan_url` to the explicit HTTPS origin (for example `'https://192.168.1.10:5756'` or `'https://uburoom.lan'`). Note that `server.listen: 'http-proxy'` rejects direct LAN connections unless a proxy in `server.trusted_proxies` also serves that LAN origin over HTTPS.

How it behaves:

- Native uburoom accounts, Jellyfin sign-in, guests, rooms, WebSockets, playback, and operator settings work directly on the LAN address.
- Discord and Plex sign-in (and account linking) bounce through `server.public_url`'s single registered callback and return to the LAN tab through a one-time handoff—no second Discord redirect URI or split DNS is needed.
- Shared invite links and password-set links continue to use `server.public_url`.
- The LAN address must still use HTTPS. If you generate a local self-signed certificate, pass `--lan` so the certificate's SANs include this machine's LAN IP and hostname:

  ```sh
  node scripts/new-dev-cert.js --lan
  ```

## If it does not work

| Symptom | Likely cause |
| --- | --- |
| 421 or "needs X-Forwarded-Proto: https" | The proxy is publishing plain HTTP or does not send the header. nginx needs `proxy_set_header X-Forwarded-Proto $scheme;`. |
| Connection reset from the proxy | The proxy's address is not in `trusted_proxies`. |
| Everyone shows the same address, rate limits trip early | `trusted_proxy_header` does not match what the proxy sends. |
| Login loops | `public_url` differs from the address in the browser (scheme, host or port). |
| Room connects then drops | The proxy does not pass WebSocket upgrades on `/watch-socket`. |
