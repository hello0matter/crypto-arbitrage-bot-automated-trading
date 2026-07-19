#!/usr/bin/env python3
"""Single-session: check if CSS file actually loads through the proxy."""
import paramiko, time

HOST = "50.114.113.121"
PORT = 22
USER = "root"
PASS = "PaSdf5z8b3t2SaZdFdj2"

def run(ch, cmd, timeout=25):
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

# 1. Fetch style.css directly from upstream (bypass proxy)
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s -D - -H 'Host: runcortex.xyz' -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36' https://runcortex.xyz/style.css 2>&1 | head -30")
print(f"\n[1] Direct upstream style.css (first 30 lines):\n{o}")

# 2. Fetch /style.css through the node proxy
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s -D - http://127.0.0.1:3030/style.css 2>&1 | head -30")
print(f"\n[2] Proxy /style.css response (first 30 lines):\n{o}")

# 3. Check all CSS-type responses the proxy handles — fetch and inspect content-type
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s -I http://127.0.0.1:3030/style.css 2>&1")
print(f"\n[3] Proxy /style.css headers:\n{o}")

# 4. Try fetching the full CSS through the proxy — show first 500 bytes
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s http://127.0.0.1:3030/style.css 2>&1 | head -c 500")
print(f"\n[4] Proxy /style.css body preview:\n{o}")

# 5. Check if there are any script tags that might inject CSS dynamically
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s http://127.0.0.1:3030/ | grep -i '<script' | head -10")
print(f"\n[5] Script tags in proxied HTML:\n{o}")

client.close()
print("\nDone.")
