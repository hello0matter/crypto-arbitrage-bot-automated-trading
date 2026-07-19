# iframe-host — Transparent Reverse Proxy

A standalone Node.js/Express reverse proxy that transparently proxies external HTTPS sites through a local server path, with content rewriting, header stripping, and URL replacement capabilities.

## Features

- **Transparent Proxying**: Serves external sites as if they come from your domain
- **Content Rewriting**: Automatically rewrites HTML/CSS/JS URLs to proxy paths
- **Header Stripping**: Removes X-Frame-Options, CSP, and other anti-framing headers
- **External CDN Proxy**: Routes Google Fonts and other blocked CDN resources through the server to bypass GFW
- **Replace Rules**: Literal and regex-based URL/text replacement (download links, referral codes, branding)
- **Base64 Attribute Rewriting**: Handles obfuscated URLs in data-stealth and similar attributes
- **WebSocket Support**: Proxies ws/wss connections for real-time features
- **OAuth Bypass Paths**: Redirect specific paths (e.g., /auth/callback) directly to origin
- **Request Header Rewriting**: Rewrites Referer/Origin headers to match target domain
- **CORS Headers**: Adds permissive CORS headers to all responses
- **Web Admin Panel**: Change target URL, configure replace rules, manage OAuth bypass paths via web UI

## Quick Start

```bash
cd iframe-host
npm install
cp config.example.json config.json
# Edit config.json with your settings
npm start
```

Access:
- Proxied site: `http://127.0.0.1:3030/` (or your configured proxy_prefix)
- Admin panel: `http://127.0.0.1:3030/admin` (or your configured admin_path)

## Configuration

### Basic Settings

```json
{
  "target_url": "https://example.com/",
  "proxy_prefix": "/internal-content",
  "port": 3030,
  "bind_host": "127.0.0.1",
  "admin_path": "admin",
  "admin_username": "admin",
  "admin_password": "strong-password-here"
}
```

### Replace Rules

Rewrite URLs and text in HTML/CSS/JS before serving:

```json
{
  "replace_rules": [
    {
      "comment": "Redirect download to your own file",
      "pattern": "https://example.com/app.exe",
      "replacement": "https://yourcdn.com/app.exe",
      "mode": "literal"
    },
    {
      "comment": "Remove referral parameters",
      "pattern": "[?&]ref=[^&\"']+",
      "replacement": "",
      "mode": "regex"
    }
  ]
}
```

**Modes:**
- `literal`: Exact string replacement (fast, for fixed URLs)
- `regex`: Regular expression replacement (flexible, for patterns)

**Execution order:** Replace rules run **before** URL rewriting, so they can match original full URLs.

### OAuth Bypass Paths

For OAuth callbacks and other paths that must go directly to the origin:

```json
{
  "oauth_bypass_paths": [
    "/auth/callback",
    "/oauth/redirect"
  ]
}
```

Requests to these paths return a 302 redirect to the origin instead of proxying.

### Request Header Rewriting

Control whether Referer/Origin headers are rewritten to match the target domain:

```json
{
  "rewrite_request_headers": true
}
```

When `true` (default), the proxy rewrites:
- `Referer: http://yourserver.com/internal-content/page` → `Referer: https://example.com/page`
- `Origin: http://yourserver.com` → `Origin: https://example.com`

This helps bypass strict CORS checks on the target site.

## How It Works

### URL Rewriting

All URLs in proxied content are rewritten to go through the proxy:

- `https://example.com/style.css` → `/internal-content/style.css`
- `/images/logo.png` → `/internal-content/images/logo.png`
- `style.css` (relative) → `/internal-content/style.css`

This applies to:
- HTML attributes: href, src, action, srcset, data-*
- CSS: url() and @import
- Inline styles: style="background: url(...)"
- Base64-encoded attributes: data-stealth, etc.

### External CDN Proxy (`/--ext-cdn/`)

External CDN resources (Google Fonts, Bootstrap CDN, etc.) are routed through the server:

**Original CSS:**
```css
@import url('https://fonts.googleapis.com/css2?family=Roboto');
```

**Rewritten:**
```css
@import url('/internal-content/--ext-cdn/?h=fonts.googleapis.com&p=/css2?family=Roboto');
```

The server fetches the resource and returns it to the browser. Font files inside the CSS are also recursively rewritten.

**Why:** In regions where CDNs are blocked (China + GFW), browsers wait 60+ seconds for CSS imports to timeout, leaving pages unstyled. This proxy makes CDN resources load instantly.

### Header Stripping

The following headers are removed from upstream responses:
- `X-Frame-Options` (allows framing)
- `Content-Security-Policy` (removes CSP restrictions)
- `Content-Security-Policy-Report-Only`

Cloudflare challenge scripts (`/cdn-cgi/`) are also stripped from HTML.

### Cookie Rewriting

Set-Cookie headers are modified:
- `Domain` attribute removed (cookies work on proxy domain)
- `SameSite` normalized to `Lax`
- `Secure` flag removed (works over HTTP during local dev)

## Deployment

### Behind Nginx

Sample nginx configuration in `deploy/nginx-internal-content.conf`:

```nginx
location ^~ /internal-content/ {
    proxy_pass http://127.0.0.1:3030/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 86400;
}
```

The `^~` modifier prevents regex location rules (like `location ~ .*\.css$`) from overriding the proxy.

### WebSocket Support

Add to nginx http block:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}
```

The Node.js server automatically handles WebSocket upgrade requests.

## Admin Panel

Access at `http://yourserver.com/internal-content-admin/` (if admin_path is "admin" and proxy_prefix is "/internal-content").

Features:
- Change target URL
- Add/remove replace rules with live preview
- View current configuration
- Change admin password

Login with credentials from `config.json`.

## Environment Variables

Override config values:

```bash
PORT=8080 ADMIN_PATH=manage npm start
```

Available:
- `PORT` — Server port (default: from config)
- `BIND_HOST` — Bind address (default: from config)
- `ADMIN_PATH` — Admin panel path (default: from config)
- `ADMIN_USERNAME` — Admin username (default: from config)
- `ADMIN_PASSWORD` — Admin password (default: from config)
- `PROXY_PREFIX` — Proxy path prefix (default: from config)
- `CONFIG_FILE` — Config file path (default: `config.json`)

## Limitations

### What This Proxy Can Handle

✅ Static sites, documentation sites, landing pages  
✅ Modern SPA frameworks (React, Vue, Next.js) with client-side routing  
✅ Sites using external CDNs (Google Fonts, Bootstrap, cdnjs)  
✅ Multi-language sites with query parameters  
✅ WebSocket connections (chat, real-time updates)  
✅ Download links (can be replaced via replace_rules)

### What May Require Extra Work

⚠️ **OAuth/Third-party login**: Use `oauth_bypass_paths` to redirect callbacks to origin  
⚠️ **Domain-based licensing**: Some apps check `window.location.hostname` in JS  
⚠️ **Subdomain-based routing**: If the site uses `api.example.com`, `cdn.example.com`, etc., each needs a separate proxy  
⚠️ **reCAPTCHA/Cloudflare Turnstile**: These validate against the registered domain  

## Security Considerations

- This proxy **removes security headers** from the target site (X-Frame-Options, CSP)
- Only proxy sites you control or are authorized to display
- Use strong admin passwords (min 12 characters)
- Keep `bind_host: "127.0.0.1"` when behind a reverse proxy
- Replace rules can modify any text in responses — use with caution

## License

MIT
