#!/usr/bin/env python3
"""Deploy fixed nginx config with ^~ prefix."""
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

# Upload fixed nginx config
sftp = client.open_sftp()
local = "deploy/nginx-internal-content.conf"
remote = "/www/server/panel/vhost/nginx/extension/50.114.113.121/iframe-host.conf"
sftp.put(local, remote)
sftp.close()
print(f"Uploaded {local} -> {remote}")

# Test nginx config
ch = client.get_transport().open_session()
o, e = run(ch, "nginx -t 2>&1")
print(f"\nNginx config test:\n{o}")
if "successful" not in o:
    print("ERROR: Config test failed!")
    client.close()
    exit(1)

# Reload nginx
ch = client.get_transport().open_session()
o, e = run(ch, "nginx -s reload 2>&1 && sleep 1 && echo 'Reloaded'")
print(f"Nginx reload: {o.strip()}")

# Test CSS through nginx
ch = client.get_transport().open_session()
o, e = run(ch, "curl -s -I -H 'Host: 50.114.113.121' http://127.0.0.1/internal-content/style.css 2>&1 | head -5")
print(f"\nCSS through nginx after fix:\n{o}")

# Test HTML through nginx
ch = client.get_transport().open_session()
o, e = run(ch, "curl -s -H 'Host: 50.114.113.121' http://127.0.0.1/internal-content/ 2>&1 | grep -i '<link.*stylesheet' | head -3")
print(f"Stylesheet link in HTML:\n{o}")

client.close()
print("\nDone. Please test in browser with Ctrl+Shift+R.")
