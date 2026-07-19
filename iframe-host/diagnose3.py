#!/usr/bin/env python3
"""Single-session: check nav HTML, JS files, and hero section structure."""
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

# 1. All <link> and <script src> tags in the HTML
ch = client.get_transport().open_session()
o, _ = run(ch, r"curl -s http://127.0.0.1:3030/ | grep -iE '<link|<script[^>]+src' | head -30")
print(f"\n[1] All link/script tags:\n{o}")

# 2. Navigation HTML — look for nav/header elements
ch = client.get_transport().open_session()
o, _ = run(ch, r"""curl -s http://127.0.0.1:3030/ | python3 -c "
import sys, re
html = sys.stdin.read()
# Find nav/header elements
m = re.search(r'(<(?:nav|header)\b.*?</(?:nav|header)>)', html, re.S|re.I)
if m: print(m.group(0)[:2000])
else:
    # fallback: just show first 200 chars of body content
    m2 = re.search(r'<body[^>]*>(.*)', html, re.S|re.I)
    if m2: print(m2.group(1)[:2000])
    else: print('No nav/header found')
" 2>&1""")
print(f"\n[2] Navigation/header HTML:\n{o[:3000]}")

# 3. Hero section — first <section> or <div class*hero>
ch = client.get_transport().open_session()
o, _ = run(ch, r"""curl -s http://127.0.0.1:3030/ | python3 -c "
import sys, re
html = sys.stdin.read()
m = re.search(r'(<(?:section|div)[^>]*(?:hero|header)[^>]*>.*?</(?:section|div)>)', html, re.S|re.I)
if m: print(m.group(0)[:1500])
else: print('No hero section found')
" 2>&1""")
print(f"\n[3] Hero/first section HTML:\n{o[:2000]}")

# 4. Fetch the main JS file and check its first 20 lines
ch = client.get_transport().open_session()
o, _ = run(ch, r"""JS_PATH=$(curl -s http://127.0.0.1:3030/ | grep -oP '(?<=src=")[^"]+\.js[^"]*' | grep -v cdn-cgi | head -1); echo "JS_PATH=$JS_PATH"; if [ -n "$JS_PATH" ]; then curl -s -D - "http://127.0.0.1:3030/$JS_PATH" 2>&1 | head -20; fi""")
print(f"\n[4] Main JS file check:\n{o[:2000]}")

# 5. Look for any hardcoded runcortex.xyz URLs in a JS file
ch = client.get_transport().open_session()
o, _ = run(ch, r"""JS_PATH=$(curl -s http://127.0.0.1:3030/ | grep -oP '(?<=src=")[^"]+\.js[^"]*' | grep -v cdn-cgi | head -1); if [ -n "$JS_PATH" ]; then curl -s "http://127.0.0.1:3030/$JS_PATH" | grep -o 'runcortex\.xyz[^"'"'"'`\s]*' | head -10; fi""")
print(f"\n[5] runcortex.xyz refs in JS:\n{o or '(none)'}")

# 6. Check if there's a style.css with background rules for nav/hero
ch = client.get_transport().open_session()
o, _ = run(ch, r"curl -s http://127.0.0.1:3030/style.css | grep -iE 'nav|header|hero' | head -30")
print(f"\n[6] Nav/header CSS rules:\n{o[:2000]}")

client.close()
print("\nDone.")
