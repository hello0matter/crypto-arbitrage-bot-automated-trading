#!/usr/bin/env python3
"""Check card_server structure"""

import paramiko

HOST = "50.114.113.121"
PORT = 22
USERNAME = "root"
PASSWORD = "PaSdf5z8b3t2SaZdFdj2"

def exec_cmd(client, cmd):
    stdin, stdout, stderr = client.exec_command(cmd)
    return stdout.read().decode(), stderr.read().decode()

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=PORT, username=USERNAME, password=PASSWORD, timeout=30)

print('Card server directory structure:')
out, _ = exec_cmd(client, 'ls -la /root/card_server/')
print(out)

print('\nChecking for public directory:')
out, _ = exec_cmd(client, 'ls -la /root/card_server/public/ 2>/dev/null || echo "No public dir"')
print(out)

print('\nChecking current tracking in server.js:')
out, _ = exec_cmd(client, 'grep -n "remoteAddress\\|x-forwarded\\|user-agent" /root/card_server/server.js | head -20')
print(out)

client.close()
