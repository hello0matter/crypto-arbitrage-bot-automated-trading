#!/usr/bin/env python3
"""Check download button implementation in the proxied page."""
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

# 1. Find download button HTML
ch = client.get_transport().open_session()
o, _ = run(ch, r"curl -s http://127.0.0.1:3030/ | grep -i 'download' | head -20")
print(f"[1] Download button/link HTML:\n{o}\n")

# 2. Search for CortexLauncher.exe in JS or HTML
ch = client.get_transport().open_session()
o, _ = run(ch, r"curl -s http://127.0.0.1:3030/ | grep -i 'CortexLauncher' | head -10")
print(f"[2] CortexLauncher mentions:\n{o}\n")

# 3. Check if there's window.location or window.open in inline JS
ch = client.get_transport().open_session()
o, _ = run(ch, r"curl -s http://127.0.0.1:3030/ | grep -E 'window\.(location|open)' | head -10")
print(f"[3] JS redirects:\n{o or '(none found)'}\n")

# 4. Check current replace_rules config
ch = client.get_transport().open_session()
o, _ = run(ch, "cat /etc/iframe-host/config.production.json 2>&1 | grep -A20 replace_rules")
print(f"[4] Current replace_rules:\n{o}\n")

client.close()
print("Done.")
