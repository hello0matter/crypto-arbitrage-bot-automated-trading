#!/usr/bin/env python3
"""Check if nginx loaded the extension config and test reloading."""
import paramiko, time

HOST = "50.114.113.121"
PORT = 22
USER = "root"
PASS = "PaSdf5z8b3t2SaZdFdj2"

def run(ch, cmd, timeout=30):
    ch.exec_command(cmd)
    out, err = b"", b""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if ch.recv_ready(): out += ch.recv(65536)
        if ch.recv_stderr_ready(): err += ch.recv_stderr(65536)
        if ch.exit_status_ready():
            while ch.recv_ready(): out += ch.recv(65536)
            while ch.recv_stderr_ready(): err += ch.recv_stderr(65536)
            break
        time.sleep(0.1)
    return out.decode("utf-8", "replace"), err.decode("utf-8", "replace")

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, PORT, USER, PASS, timeout=15, banner_timeout=15)
print(f"Connected to {HOST}")

# 1. Check if extension conf is included in main vhost
ch = client.get_transport().open_session()
o, _ = run(ch, "grep -r 'extension/50.114.113.121' /www/server/panel/vhost/nginx/ 2>&1 | head -10")
print(f"[1] Extension include in main config:\n{o}\n")

# 2. Test nginx config syntax
ch = client.get_transport().open_session()
o, _ = run(ch, "nginx -t 2>&1")
print(f"[2] Nginx config test:\n{o}\n")

# 3. Reload nginx
ch = client.get_transport().open_session()
o, _ = run(ch, "nginx -s reload 2>&1 && sleep 1 && echo 'Nginx reloaded'")
print(f"[3] Nginx reload:\n{o}\n")

# 4. Test CSS again after reload
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s -I -H 'Host: 50.114.113.121' http://127.0.0.1/internal-content/style.css 2>&1 | head -10")
print(f"[4] CSS after nginx reload:\n{o}\n")

# 5. Check main vhost file for this IP
ch = client.get_transport().open_session()
o, _ = run(ch, "cat /www/server/panel/vhost/nginx/50.114.113.121.conf 2>&1 | head -50")
print(f"[5] Main vhost config (first 50 lines):\n{o}\n")

client.close()
print("\nDone.")
