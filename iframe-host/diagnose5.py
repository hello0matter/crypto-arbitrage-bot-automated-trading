#!/usr/bin/env python3
"""Single-session: verify CSS @import rewriting is working."""
import paramiko, time

HOST = "50.114.113.121"
PORT = 22
USER = "root"
PASS = "PaSdf5z8b3t2SaZdFdj2"

def run(ch, cmd, timeout=25):
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

# 1. Fetch style.css through proxy and show first 10 lines (check if @import was rewritten)
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s http://127.0.0.1:3030/style.css 2>&1 | head -15")
print(f"\n[1] First 15 lines of proxied style.css:\n{o}")

# 2. Check if the @import still points to googleapis or was rewritten to /--ext-cdn/
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s http://127.0.0.1:3030/style.css | grep -E '@import' | head -5")
print(f"\n[2] @import lines in proxied CSS:\n{o or '(no @import found)'}")

# 3. Test the /--ext-cdn/ endpoint directly
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s -D - 'http://127.0.0.1:3030/--ext-cdn/?h=fonts.googleapis.com&p=/css2?family=Rajdhani' 2>&1 | head -30")
print(f"\n[3] Direct test of /--ext-cdn/ handler:\n{o[:2000]}")

# 4. Check server.js on remote to confirm the code is actually there
ch = client.get_transport().open_session()
o, _ = run(ch, "grep -n 'ext-cdn' /opt/iframe-host/server.js | head -10")
print(f"\n[4] ext-cdn code in deployed server.js:\n{o}")

# 5. Check recent error logs
ch = client.get_transport().open_session()
o, _ = run(ch, "journalctl -u iframe-host -n 20 --no-pager 2>&1 | grep -iE 'error|warn|exception' || echo '(no errors in last 20 lines)'")
print(f"\n[5] Recent errors:\n{o}")

client.close()
print("\nDone.")
