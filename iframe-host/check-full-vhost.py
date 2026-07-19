#!/usr/bin/env python3
"""Check full vhost config and test exact nginx routing."""
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

# 1. Full vhost config (look for location blocks that might interfere)
ch = client.get_transport().open_session()
o, _ = run(ch, "cat /www/server/panel/vhost/nginx/50.114.113.121.conf 2>&1")
print(f"[1] FULL vhost config:\n{o}\n{'='*80}\n")

# 2. Check if there's a catch-all location ~ \.css
ch = client.get_transport().open_session()
o, _ = run(ch, "grep -n 'location.*css' /www/server/panel/vhost/nginx/50.114.113.121.conf 2>&1 || echo 'No CSS location'")
print(f"[2] CSS-specific locations:\n{o}\n")

# 3. Test node directly to ensure it's working
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s http://127.0.0.1:3030/style.css 2>&1 | wc -c")
print(f"[3] Direct node /style.css byte count: {o}\n")

# 4. Test with explicit proxy_pass (bypass nginx location matching)
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s 'http://127.0.0.1:3030/style.css' 2>&1 | head -10")
print(f"[4] Direct node first 10 lines:\n{o}\n")

client.close()
print("\nDone.")
