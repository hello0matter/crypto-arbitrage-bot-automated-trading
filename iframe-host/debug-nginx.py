#!/usr/bin/env python3
"""Debug nginx routing issue."""
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

# 1. Nginx extension config
ch = client.get_transport().open_session()
o, _ = run(ch, "cat /www/server/panel/vhost/nginx/extension/50.114.113.121/*.conf 2>&1")
print(f"[1] Nginx extension config:\n{o}\n")

# 2. Test nginx → node for HTML (should work)
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s -H 'Host: 50.114.113.121' http://127.0.0.1/internal-content/ 2>&1 | grep -i 'cortex\\|<title>' | head -3")
print(f"[2] HTML through nginx:\n{o}\n")

# 3. Test direct access to node for CSS (we know this works)
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s -I http://127.0.0.1:3030/style.css 2>&1 | head -5")
print(f"[3] Direct node /style.css:\n{o}\n")

# 4. Test what nginx actually forwards to node for CSS request
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -v -H 'Host: 50.114.113.121' http://127.0.0.1/internal-content/style.css 2>&1 | head -30")
print(f"[4] Nginx CSS verbose:\n{o}\n")

# 5. Check nginx error log
ch = client.get_transport().open_session()
o, _ = run(ch, "tail -20 /www/wwwlogs/50.114.113.121-error.log 2>&1 || echo 'No error log'")
print(f"[5] Nginx error log:\n{o}\n")

# 6. List actual extension conf files
ch = client.get_transport().open_session()
o, _ = run(ch, "ls -lh /www/server/panel/vhost/nginx/extension/50.114.113.121/ 2>&1")
print(f"[6] Extension conf files:\n{o}\n")

client.close()
print("\nDone.")
