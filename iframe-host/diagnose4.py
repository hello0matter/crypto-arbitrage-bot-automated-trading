#!/usr/bin/env python3
"""Single-session: check page bottom + actual body/nav CSS rules + Google Fonts issue."""
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

# 1. Last 40 lines of page (any script tags at bottom?)
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s http://127.0.0.1:3030/ | tail -40")
print(f"\n[1] Last 40 lines of HTML:\n{o[:3000]}")

# 2. Actual .site-header and body CSS rules
ch = client.get_transport().open_session()
o, _ = run(ch, r"""curl -s http://127.0.0.1:3030/style.css | python3 -c "
import sys, re
css = sys.stdin.read()
# Extract body rule
m = re.search(r'body\s*\{[^}]+\}', css)
if m: print('body rule:', m.group(0)[:500])
# Extract .site-header rule
m2 = re.search(r'\.site-header\s*\{[^}]+\}', css)
if m2: print('.site-header:', m2.group(0)[:500])
# Extract .nav-links rule
m3 = re.search(r'\.nav-links\s*\{[^}]+\}', css)
if m3: print('.nav-links:', m3.group(0)[:500])
# Extract .nav-links a rule
m4 = re.search(r'\.nav-links\s+a\s*\{[^}]+\}', css)
if m4: print('.nav-links a:', m4.group(0)[:500])
# Check for @import
imports = re.findall(r'@import[^;]+;', css)
print('Imports:', imports)
" 2>&1""")
print(f"\n[2] Key CSS rules:\n{o[:3000]}")

# 3. Check if Google Fonts is reachable from server
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 5 'https://fonts.googleapis.com/css2?family=Rajdhani' 2>&1")
print(f"\n[3] Google Fonts reachability: {o}")

# 4. Full page size and inline style blocks count
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s http://127.0.0.1:3030/ | wc -c; echo '---'; curl -s http://127.0.0.1:3030/ | grep -c '<style'")
print(f"\n[4] Page size (bytes) / inline style blocks:\n{o}")

# 5. Check if there's any script at the bottom that might handle nav
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s http://127.0.0.1:3030/ | grep -iE 'script|<style' | tail -20")
print(f"\n[5] All script/style tags:\n{o[:2000]}")

client.close()
print("\nDone.")
