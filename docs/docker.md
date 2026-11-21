# Running uburoom in Docker

This guide explains how to containerize and run uburoom using Docker and Docker Compose.

---

## Prerequisites

- [Docker Engine](https://docs.docker.com/engine/install/) and [Docker Compose](https://docs.docker.com/compose/) (v2+), or Docker Desktop on Windows/macOS.
- A media source the container can reach: a Plex or Jellyfin server, or folders mounted into the container.

---

## Directory Setup

Create a working directory for your uburoom instance or use the root of your repository clone. `config/` can start empty: first-run setup writes `config.yaml` and the certificate into it.

```
uburoom/
├── docker-compose.yml
├── config/              → /config in the container (writable)
│   ├── config.yaml      (written by first-run setup)
│   └── data/            (created by setup; holds certs/ and the database)
└── secrets/             → /var/lib/uburoom
```

The container starts with `--config /config/config.yaml --setup-host 0.0.0.0`, and relative paths in `config.yaml` resolve beside it, so `data` and setup's `data/certs/...` point into `config/`. Mount the **folder**, not a single file: Server settings saves write a new `config.yaml` beside the old one and swap it in, which fails on a read-only or single-file mount.

### 1. Persistent Data and Secrets

Docker will create directories for missing volume sources if they do not already exist on the host (often owned by `root` on Linux). Because the container runs as the non-root `node` user (`UID 1000`, `GID 1000`), create and set ownership on the mounted directories on Linux hosts before starting the container:

```sh
# Create the configuration folder (config, certificates, data) and the secrets folder:
mkdir -p config secrets

# Grant ownership to the container's non-root user (UID/GID 1000) and keep both private:
chown -R 1000:1000 config secrets
chmod 700 config secrets
```

> [!IMPORTANT]
> **Preserve `secrets/` and `config/`:**
> `credentials.key` is a 32-byte encryption key generated automatically on first startup inside `secrets/` (persisted from `/var/lib/uburoom/uburoom/credentials.key`) and used to protect stored provider tokens in `config/data/accounts.sqlite`. If you lose this key, encrypted credentials cannot be decrypted and will need to be re-authenticated. Back up `secrets/` and `config/` together.

### 2. First run

Start the container (see [Managing the Container](#managing-the-container)) with the empty `config/` folder. With no `config.yaml`, uburoom starts first-run setup:

```sh
docker compose up -d
docker logs uburoom    # shows the setup code
```

Open `https://<Docker host address>:<published port>/setup` and enter the code. For a mapping of `6756:5756`, open `https://localhost:6756/setup` on the Docker host, or use the host's LAN IP and port `6756` for **My home network**. Setup is served over HTTPS with a certificate made when it starts, so the browser warns once. The wizard keeps the container listening on port `5756` and uses the browser-facing address and published port for `server.public_url`, the sign-in handoff and Discord's callback. Docker's port binding controls which host interfaces are reachable. Publish on `127.0.0.1` for access confined to the Docker host. The wizard writes `config/config.yaml` and a self-signed certificate in `config/data/certs/`. The container's health check reaches setup's `/health` during setup. See [first-run setup](self-hosting.md#first-run-setup).

---

## Configuration by hand (`config.yaml`)

Instead of first-run setup, you can write the config yourself. Copy `config.example.yaml` to `config/config.yaml`:

```sh
cp config.example.yaml config/config.yaml
```

On Linux hosts, ensure `config.yaml` is readable and writable by UID `1000` while keeping it restricted from other host users (for example, `chown 1000:1000 config/config.yaml && chmod 600 config/config.yaml`).

A hand-written config also needs a certificate and key for `server.tls_cert` and `server.tls_key` (unless `server.listen` is `http-proxy`), for example a self-signed pair for a local test:

```sh
mkdir -p config/certs
openssl req -x509 -newkey rsa:2048 -nodes   -keyout config/certs/server-key.pem   -out config/certs/server-cert.pem   -days 365   -subj "/CN=localhost"
```

On Linux hosts, ensure both PEM files are readable by UID `1000` (for example, `chown 1000:1000 config/certs/*.pem && chmod 600 config/certs/server-key.pem`).

Key configuration adjustments for Docker deployments:

### Network & Host Binding

Inside a container, `127.0.0.1` refers to the container's local network loopback. uburoom must bind to `0.0.0.0` so published container ports are accessible from outside:

```yaml
server:
  host: '0.0.0.0'
  port: 5756
  public_url: 'https://watch.example.com' # Your public HTTPS origin
  tls_cert: 'certs/server-cert.pem'
  tls_key: 'certs/server-key.pem'
```

### Connecting to Plex

- **Plex on another machine or LAN IP:** Use the LAN IP directly:
  ```yaml
  sources:
    - id: 'living-room'
      type: 'plex'
      url: 'http://192.168.1.100:32400'
      token: 'YOUR_PLEX_TOKEN'
  ```
- **Plex on the same host machine:** Container loopback (`127.0.0.1`) cannot reach the host. Use `host.docker.internal`:
  ```yaml
  sources:
    - id: 'living-room'
      type: 'plex'
      url: 'http://host.docker.internal:32400'
      token: 'YOUR_PLEX_TOKEN'
  ```
  *(On Linux hosts, ensure `extra_hosts` is enabled in `docker-compose.yml` to resolve `host.docker.internal`).*

### Storage Paths

Leave `storage.data_directory` set to default `'data'`. It resolves beside `config.yaml`, so data is stored in `config/data/` on the host.

```yaml
storage:
  data_directory: 'data'
```

---

## Docker Compose Configuration

The included `docker-compose.yml` defines the `uburoom` service:

```yaml
services:
  uburoom:
    build: .
    container_name: uburoom
    restart: unless-stopped
    stop_grace_period: 45s
    ports:
      - "5756:5756"
    volumes:
      # config.yaml, certs/ and data/ (writable: Server settings save here)
      - ./config:/config
      # credentials.key; back up together with config/
      - ./secrets:/var/lib/uburoom
    # Optional: Hardware transcoding acceleration for Intel / AMD GPUs (VAAPI/QSV)
    # devices:
    #   - /dev/dri:/dev/dri
    # Optional: Required on Linux hosts when Plex runs directly on the host machine
    # and config.yaml connects to http://host.docker.internal:32400
    # extra_hosts:
    #   - "host.docker.internal:host-gateway"
```

---

## Managing the Container

### Build the Image

```sh
docker compose build
```

### Start uburoom in the Background

```sh
docker compose up -d
```

### View Live Logs

```sh
docker compose logs -f
```

### Check Container Status

```sh
docker compose ps
```

You can verify server health from the host:

```sh
curl -k https://localhost:5756/health
```

### Stop the Container

```sh
docker compose down
```

*Stopping or removing the container does not delete your configuration, database or encryption key as long as `./config` and `./secrets` are persisted on the host.*

---

## Hardware Transcoding (Optional)

uburoom includes built-in video conversion and subtitle extraction using FFmpeg. By default (`GPU_DRIVERS=none`), the container image omits optional GPU user-space drivers to stay minimal (~789 MB). You can opt in to drivers at build time with `--build-arg GPU_DRIVERS=<mode>`:

| `GPU_DRIVERS` | Added image size | Included drivers | When to choose |
| --- | --- | --- | --- |
| `none` (default) | `0 MB` | CPU / software FFmpeg only | Smallest image; no GPU device passthrough needed |
| `vulkan` | `+~61 MB` | `mesa-vulkan-drivers` | Vulkan `libplacebo` tonemapping / Dolby Vision Profile 5 filter paths |
| `all` | `+~89 MB` | `mesa-vulkan-drivers`, `mesa-va-drivers`, plus `intel-media-va-driver` on `amd64` | Intel Quick Sync / VAAPI or AMD GPU hardware conversion via `/dev/dri` alongside Vulkan filters |

If your host has an Intel processor with Quick Sync Video (QSV) or an AMD GPU on Linux:

1. Rebuild with the desired driver set (or configure `build.args.GPU_DRIVERS` in `docker-compose.yml`):
   ```sh
   docker compose build --build-arg GPU_DRIVERS=all
   ```
2. In `docker-compose.yml`, uncomment the `devices` block:
   ```yaml
   devices:
     - /dev/dri:/dev/dri
   ```
3. Verify access permissions on the host:
   ```sh
   ls -la /dev/dri
   ```
   Ensure the user or container has permission to access `/dev/dri/renderD128`.

---

## Optional: Caddy Reverse Proxy Recipe

If you are hosting uburoom publicly and want automated HTTPS certificates via Let's Encrypt or ZeroSSL, [Caddy](https://caddyserver.com/) is recommended. Caddy serves your domain over HTTPS and talks plain HTTP to uburoom over a private Compose network (`server.listen: 'http-proxy'`), so uburoom needs no certificate and Caddy needs no `tls_insecure_skip_verify`. Cloudflare Tunnel and Tailscale work the same way; see [remote access](remote-access.md) for every route.

uburoom is only `expose`d, never published with `ports:`: published traffic can arrive from the Docker bridge gateway, which a broad CIDR would trust. Both services share a network with a fixed subnet, and `trusted_proxies` lists exactly that subnet.

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

  caddy:
    image: caddy:2-alpine
    container_name: uburoom-caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - uburoom
    networks:
      - edge

networks:
  edge:
    ipam:
      config:
        - subnet: 172.30.0.0/24

volumes:
  caddy_data:
  caddy_config:
```

### Example `Caddyfile`

Caddy gets a trusted certificate by itself, sends `X-Forwarded-For` and `X-Forwarded-Proto`, and passes WebSocket upgrades on `/watch-socket` without extra settings:

```caddy
watch.example.com {
    reverse_proxy uburoom:5756
}
```

### `config.yaml` behind Caddy

```yaml
server:
  listen: 'http-proxy'
  host: '0.0.0.0'
  port: 5756
  public_url: 'https://watch.example.com'
  trusted_proxies: ['172.30.0.0/24'] # the Compose network above
  trusted_proxy_header: 'x-forwarded-for'
```

Remove `tls_cert` and `tls_key`; they are not read in this mode (the doctor warns if they are set). The container's health check follows `server.listen` and asks `/health` over plain HTTP.

> [!NOTE]
> To keep uburoom's own HTTPS listener instead (the default, `server.listen: 'https'`), point Caddy at `https://uburoom:5756`. Caddy then has to trust uburoom's certificate, which for a self-signed one means turning verification off; `http-proxy` avoids that.
