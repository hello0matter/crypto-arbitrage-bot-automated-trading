#!/usr/bin/env python3
"""Check the full CSS loading chain from browser perspective."""
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

# 1. HTML <link> tag pointing to style.css
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s http://127.0.0.1:3030/ | grep -i 'stylesheet' | head -5")
print(f"[1] Stylesheet link in HTML:\n{o}\n")

# 2. Test style.css loads with correct content-type
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s -I http://127.0.0.1:3030/style.css 2>&1 | head -15")
print(f"[2] style.css response headers:\n{o}\n")

# 3. Check if there are syntax errors in the rewritten CSS (first 30 lines)
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s http://127.0.0.1:3030/style.css 2>&1 | head -30")
print(f"[3] First 30 lines of rewritten CSS:\n{o}\n")

# 4. Test through nginx (full browser path) instead of direct to Node
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s -H 'Host: 50.114.113.121' http://127.0.0.1/internal-content/style.css 2>&1 | head -20")
print(f"[4] CSS through nginx (browser path):\n{o}\n")

# 5. Check if CSS variables are defined
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s http://127.0.0.1:3030/style.css | grep -A5 ':root' | head -15")
print(f"[5] CSS :root variables:\n{o}\n")

# 6. Check .site-header rule is present
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s http://127.0.0.1:3030/style.css | grep -A10 '\\.site-header' | head -20")
print(f"[6] .site-header CSS rule:\n{o}\n")

client.close()
print("\nDone.")
