#!/usr/bin/env python3
import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('50.114.113.121', port=22, username='root', password='PaSdf5z8b3t2SaZdFdj2', timeout=30)

print('=== Finding iframe-host credentials ===\n')

print('1. Check config.example.json for defaults:')
stdin, stdout, stderr = client.exec_command('cat /opt/iframe-host/config.example.json')
print(stdout.read().decode('utf-8', errors='ignore'))

print('\n2. Check systemd service file:')
stdin, stdout, stderr = client.exec_command('cat /etc/systemd/system/iframe-host.service 2>/dev/null || systemctl cat iframe-host 2>/dev/null || echo "No systemd service"')
print(stdout.read().decode('utf-8', errors='ignore'))

print('\n3. Check how process was started:')
stdin, stdout, stderr = client.exec_command('ps -fp 57307')
print(stdout.read().decode('utf-8', errors='ignore'))

print('\n4. Try reading from server.js default values:')
stdin, stdout, stderr = client.exec_command('grep -A 2 "process.env.ADMIN" /opt/iframe-host/server.js | head -20')
print(stdout.read().decode('utf-8', errors='ignore'))

client.close()
