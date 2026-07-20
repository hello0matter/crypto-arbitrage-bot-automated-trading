#!/usr/bin/env python3
import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('50.114.113.121', port=22, username='root', password='PaSdf5z8b3t2SaZdFdj2', timeout=30)

print('=== Checking /opt/iframe-host/ ===\n')

print('1. Directory listing:')
stdin, stdout, stderr = client.exec_command('ls -la /opt/iframe-host/')
print(stdout.read().decode('utf-8', errors='ignore'))

print('\n2. Checking server.js for admin credentials:')
stdin, stdout, stderr = client.exec_command('grep -i "admin" /opt/iframe-host/server.js | head -20')
print(stdout.read().decode('utf-8', errors='ignore'))

print('\n3. Environment variables:')
stdin, stdout, stderr = client.exec_command('cat /opt/iframe-host/.env 2>/dev/null || echo "No .env file"')
print(stdout.read().decode('utf-8', errors='ignore'))

print('\n4. Check nginx config for admin path:')
stdin, stdout, stderr = client.exec_command('grep -r "internal-content-admin" /etc/nginx/ 2>/dev/null')
output = stdout.read().decode('utf-8', errors='ignore')
if output:
    print(output)
else:
    print('Not found in nginx config')

print('\n5. Check process environment:')
stdin, stdout, stderr = client.exec_command('cat /proc/57307/environ | tr "\\0" "\\n" | grep -i admin')
print(stdout.read().decode('utf-8', errors='ignore'))

client.close()
