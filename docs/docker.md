# Running uburoom in Docker

This guide explains how to containerize and run uburoom using Docker and Docker Compose.

---

## Prerequisites

- [Docker Engine](https://docs.docker.com/engine/install/) and [Docker Compose](https://docs.docker.com/compose/) (v2+), or Docker Desktop on Windows/macOS.
- An authorized Plex token and reachable Plex Media Server.
- A local TLS certificate and private key (uburoom requires HTTPS even behind a reverse proxy).

---

## Directory Setup

Create a working directory for your uburoom instance or use the root of your repository clone. Ensure the following files and directories exist before launching the container:

```
uburoom/
├── docker-compose.yml
├── config/              → /config in the container (writable)
│   ├── config.yaml
│   ├── certs/
│   │   ├── server-cert.pem
│   │   └── server-key.pem
│   └── data/            (created on first start)
└── secrets/             → /var/lib/uburoom
```

The container starts with `--config /config/config.yaml`, and relative paths in `config.yaml` resolve beside it, so the default `certs/...` and `data` settings point into `config/`. Mount the **folder**, not a single file: Server settings saves write a new `config.yaml` beside the old one and swap it in, which fails on a read-only or single-file mount.

### 1. Persistent Data and Secrets

Docker will create directories for missing volume sources if they do not already exist on the host (often owned by `root` on Linux). Because the container runs as the non-root `node` user (`UID 1000`, `GID 1000`), create and set ownership on the mounted directories on Linux hosts before starting the container:

```sh
# Create the configuration folder (config, certificates, data) and the secrets folder:
mkdir -p config/certs secrets

# Grant ownership to the container's non-root user (UID/GID 1000) and keep both private:
chown -R 1000:1000 config secrets
chmod 700 config secrets
```

> [!IMPORTANT]
> **Preserve `secrets/` and `config/`:**
> `credentials.key` is a 32-byte encryption key generated automatically on first startup inside `secrets/` (persisted from `/var/lib/uburoom/uburoom/credentials.key`) and used to protect stored provider tokens in `config/data/accounts.sqlite`. If you lose this key, encrypted credentials cannot be decrypted and will need to be re-authenticated. Back up `secrets/` and `config/` together.

### 2. TLS Certificates

uburoom requires TLS certificates to establish an HTTPS listener. Place your PEM-formatted certificate and private key in the `config/certs/` folder:

- `config/certs/server-cert.pem`
- `config/certs/server-key.pem`

If testing locally without a public domain, you can generate self-signed certificates using `mkcert` or OpenSSL:

```sh
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout config/certs/server-key.pem \
  -out config/certs/server-cert.pem \
  -days 365 \
  -subj "/CN=localhost"
```

On Linux hosts, ensure both PEM files are readable by UID `1000` (for example, `chown 1000:1000 config/certs/*.pem && chmod 600 config/certs/server-key.pem`).

---

## Configuration (`config.yaml`)

Copy `config.example.yaml` to `config/config.yaml`:

```sh
cp config.example.yaml config/config.yaml
```

On Linux hosts, ensure `config.yaml` is readable and writable by UID `1000` while keeping it restricted from other host users (for example, `chown 1000:1000 config/config.yaml && chmod 600 config/config.yaml`).

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
  plex:
    url: 'http://192.168.1.100:32400'
    token: 'YOUR_PLEX_TOKEN'
  ```
- **Plex on the same host machine:** Container loopback (`127.0.0.1`) cannot reach the host. Use `host.docker.internal`:
  ```yaml
  plex:
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

If you are hosting uburoom publicly and want automated HTTPS certificates via Let's Encrypt or ZeroSSL, [Caddy](https://caddyserver.com/) is recommended.

Below is an example `docker-compose.yml` that runs uburoom alongside Caddy:

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

volumes:
  caddy_data:
  caddy_config:
```

### Example `Caddyfile`

Caddy automatically handles WebSocket upgrade headers on `/watch-socket` and proxies requests to uburoom's HTTPS listener:

```caddy
watch.example.com {
    reverse_proxy https://uburoom:5756 {
        # Trust uburoom's internal self-signed certificate:
        transport http {
            tls_insecure_skip_verify
        }
    }
}
```

### Trusting Proxy Headers in `config.yaml`

By default, uburoom ignores forwarding headers (`server.trusted_proxies: []`). When running behind Caddy on a Docker bridge network, configure `server.trusted_proxies` and `server.trusted_proxy_header` in `config.yaml` so rate limits and LAN detection see the real client IP instead of Caddy's container address:

```yaml
server:
  trusted_proxies: ['172.16.0.0/12'] # Docker bridge subnet range (or your Compose network CIDR)
  trusted_proxy_header: 'x-forwarded-for'
```

> [!NOTE]
> Even when behind a TLS-terminating reverse proxy like Caddy or Nginx, uburoom requires its internal listener to be configured with HTTPS. Setting `tls_insecure_skip_verify` allows Caddy to proxy traffic securely over internal container networks to uburoom's HTTPS listener.
