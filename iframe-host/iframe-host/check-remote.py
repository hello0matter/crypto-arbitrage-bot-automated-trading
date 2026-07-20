#!/usr/bin/env python3
"""Check remote server state"""

import paramiko

HOST = "50.114.113.121"
PORT = 22
USERNAME = "root"
PASSWORD = "PaSdf5z8b3t2SaZdFdj2"
REMOTE_DIR = "/root/iframe-host"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=PORT, username=USERNAME, password=PASSWORD, timeout=30)

print("Checking remote directory...")
stdin, stdout, stderr = client.exec_command(f"ls -la {REMOTE_DIR}/")
print(stdout.read().decode())

print("\nChecking if pm2 is running iframe-host...")
stdin, stdout, stderr = client.exec_command("pm2 list")
print(stdout.read().decode())

client.close()
