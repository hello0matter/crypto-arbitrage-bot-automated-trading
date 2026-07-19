#!/usr/bin/env python3
"""Verify the double-prefix fix is working."""
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

# Check @import after fix
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s http://127.0.0.1:3030/style.css | grep '@import' | head -3")
print(f"@import line in CSS:\n{o}")

# Test accessing the ext-cdn URL directly
ch = client.get_transport().open_session()
o, _ = run(ch, "curl -s -w '\\nHTTP_CODE:%{http_code}' 'http://127.0.0.1:3030/--ext-cdn/?h=fonts.googleapis.com&p=/css2?family=Rajdhani' 2>&1 | head -10")
print(f"\nDirect ext-cdn test:\n{o}")

client.close()
print("\nDone. Please test with Ctrl+Shift+R in browser.")
