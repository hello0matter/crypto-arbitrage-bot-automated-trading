#!/usr/bin/env python3
"""Single-session SSH diagnostic for iframe-host CSS issue."""
import paramiko, time

HOST = "50.114.113.121"
PORT = 22
USER = "root"
PASS = "PaSdf5z8b3t2SaZdFdj2"

def run(ch, cmd, timeout=20):
    ch.exec_command(cmd)
    out = b""
    err = b""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if ch.recv_ready():
            out += ch.recv(65536)
        if ch.recv_stderr_ready():
            err += ch.recv_stderr(65536)
        if ch.exit_status_ready():
            while ch.recv_ready():
                out += ch.recv(65536)
            while ch.recv_stderr_ready():
                err += ch.recv_stderr(65536)
            break
        time.sleep(0.1)
    return out.decode("utf-8", "replace"), err.decode("utf-8", "replace")

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, PORT, USER, PASS, timeout=15, banner_timeout=15)
print(f"Connected to {HOST}")

# ── 1. Service status ────────────────────────────────────────────────────────
ch = client.get_transport().open_session()
o, _ = run(ch, "systemctl is-active iframe-host 2>&1")
print(f"\n[1] Service status: {o.strip()}")

# ── 2. Fetch HTML from proxy, show <link> stylesheet lines ──────────────────
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s http://127.0.0.1:3030/ | grep -i 'link.*stylesheet\\|<style\\|_next/static/css' | head -20")
print(f"\n[2] CSS links in proxy HTML:\n{o[:3000]}")

# ── 3. Fetch HTML, look for any /internal-content doubled prefix ─────────────
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s http://127.0.0.1:3030/ | grep -o 'internal-content/internal-content' | head -5")
print(f"\n[3] Double-prefix occurrences: {repr(o.strip()) or '(none found — good)'}")

# ── 4. Extract first CSS URL and fetch it ───────────────────────────────────
ch = client.get_transport().open_session()
o, _ = run(ch, r"""CSS_PATH=$(curl -s http://127.0.0.1:3030/ | grep -oP '(?<=href=")[^"]*\.css[^"]*' | head -1); echo "CSS_PATH=$CSS_PATH"; if [ -n "$CSS_PATH" ]; then echo "--- Fetching: http://127.0.0.1:3030$CSS_PATH ---"; RESP=$(curl -s -D - http://127.0.0.1:3030$CSS_PATH 2>&1 | head -40); echo "$RESP"; fi""")
print(f"\n[4] First CSS file response:\n{o[:3000]}")

# ── 5. Check nginx config is passing through properly ───────────────────────
ch = client.get_transport().open_session()
o, _ = run(ch, "cat /www/server/panel/vhost/nginx/extension/50.114.113.121/*.conf 2>/dev/null | head -40 || echo 'No extension conf found'")
print(f"\n[5] Nginx extension conf:\n{o[:2000]}")

# ── 6. Recent proxy logs ─────────────────────────────────────────────────────
ch = client.get_transport().open_session()
o, _ = run(ch, "journalctl -u iframe-host -n 30 --no-pager 2>&1 | tail -30")
print(f"\n[6] Recent iframe-host logs:\n{o[:3000]}")

# ── 7. Fetch proxy HTML and show first 60 lines ──────────────────────────────
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s http://127.0.0.1:3030/ | head -60")
print(f"\n[7] First 60 lines of proxied HTML:\n{o[:4000]}")

client.close()
print("\nDone — connection closed.")
