#!/usr/bin/env python3
"""Single-session deploy: upload server.js and restart iframe-host."""
import paramiko, stat, time

HOST = "50.114.113.121"
PORT = 22
USER = "root"
PASS = "PaSdf5z8b3t2SaZdFdj2"
REMOTE_DIR = "/opt/iframe-host"
LOCAL_FILE = "server.js"

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

sftp = client.open_sftp()
sftp.put(LOCAL_FILE, f"{REMOTE_DIR}/{LOCAL_FILE}")
sftp.close()
print(f"Uploaded {LOCAL_FILE}")

ch = client.get_transport().open_session()
o, e = run(ch, f"systemctl restart iframe-host && sleep 1 && systemctl is-active iframe-host")
print(f"Restart: {o.strip()}")
if e.strip(): print(f"  stderr: {e.strip()}")

ch = client.get_transport().open_session()
o, e = run(ch, "journalctl -u iframe-host -n 5 --no-pager 2>&1")
print(f"Recent logs:\n{o}")

client.close()
print("Done — connection closed.")
