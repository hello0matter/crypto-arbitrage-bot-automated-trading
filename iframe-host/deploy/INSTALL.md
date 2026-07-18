# Linux deployment

This service is intended for a dedicated, non-device-control server.

## Layout

1. Create a service account:

```bash
sudo useradd --system --home /opt/iframe-host --shell /usr/sbin/nologin iframehost
```

2. Copy the application files:

```bash
sudo mkdir -p /opt/iframe-host /etc/iframe-host
sudo cp -r iframe-host/* /opt/iframe-host/
cd /opt/iframe-host
sudo npm ci --omit=dev
```

3. Install configuration:

```bash
sudo cp deploy/iframe-host.env.example /etc/iframe-host/iframe-host.env
sudo cp config.example.json /etc/iframe-host/config.production.json
sudo chown -R iframehost:iframehost /opt/iframe-host /etc/iframe-host
sudo chmod 640 /etc/iframe-host/iframe-host.env /etc/iframe-host/config.production.json
```

4. Validate before starting:

```bash
cd /opt/iframe-host
sudo -u iframehost node check-config.js /etc/iframe-host/config.production.json
sudo -u iframehost CONFIG_FILE=/etc/iframe-host/config.production.json node --check server.js
```

5. Install and start the systemd service:

```bash
sudo cp deploy/iframe-host.service /etc/systemd/system/iframe-host.service
sudo systemctl daemon-reload
sudo systemctl enable --now iframe-host
sudo systemctl status iframe-host
```

6. Add the Nginx location from `deploy/nginx-internal-content.conf` to your site and reload Nginx.

## Notes

- Keep `BIND_HOST=127.0.0.1` when publishing through Nginx.
- Edit `/etc/iframe-host/config.production.json` and restart `iframe-host` to change the embedded page.
- Do not use this service on a host that already runs device control, remote command, or unrelated admin infrastructure.
