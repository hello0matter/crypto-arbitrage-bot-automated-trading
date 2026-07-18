# Constrained iframe host

A small, standalone Node/Express service that embeds one explicitly approved HTTPS page. It is intended for internal, informational content that you are authorized to display.

It deliberately does **not** provide:

- Interactive or admin-side target URL changes
- Visitor analytics, IP/User-Agent collection, or persistent access logs
- Form submission, pop-ups, top-level navigation, or browser permissions inside the iframe
- A device-control, card-service, or remote-command integration

## Configure

Copy the example file, then replace the example domain with an HTTPS origin you control or are authorized to embed:

```powershell
cd iframe-host
Copy-Item config.example.json config.json
notepad config.json
```

`target_url` must use HTTPS, and its origin must appear exactly in `allowed_origins`.

```json
{
  "target_url": "https://docs.example.com/handbook",
  "allowed_origins": [
    "https://docs.example.com"
  ],
  "title": "Internal handbook",
  "port": 3030,
  "bind_host": "127.0.0.1"
}
```

The default `bind_host` is loopback-only. Keep it that way when placing the service behind a reverse proxy. Use `0.0.0.0` only on a protected internal network.

## Run

```powershell
cd iframe-host
npm install
npm start
```

Open:

- Embedded page: `http://127.0.0.1:3030/`

To use a separate, local-only configuration file:

```powershell
$env:CONFIG_FILE = "config.local.json"
npm start
```

`PORT` and `BIND_HOST` may be overridden through environment variables. Target URLs and allowed origins are intentionally read only from the configuration file.

Quick validation:

```powershell
npm run check
```

Build an uploadable archive:

```powershell
npm run package
```

The archive is written to `dist/` and contains only the runtime files plus `deploy/`.

## Deployment notes

The iframe is sandboxed with scripts only. Login forms, pop-ups, top-level redirects, downloads, and browser permissions are intentionally unavailable. Some sites will also refuse embedding through their own `X-Frame-Options` or CSP headers; that is expected and should not be bypassed.

When publishing through Nginx, keep Node bound to loopback and proxy only the required path:

```nginx
location /internal-content/ {
    proxy_pass http://127.0.0.1:3030/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

This service does not expose an admin UI or record visitor activity. Edit `config.json` locally and restart the service to change the approved page.

For a dedicated Linux host, use the templates in `deploy/`:

- `deploy/iframe-host.service`
- `deploy/iframe-host.env.example`
- `deploy/nginx-internal-content.conf`
- `deploy/INSTALL.md`
