#!/usr/bin/env python3
import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('50.114.113.121', port=22, username='root', password='PaSdf5z8b3t2SaZdFdj2', timeout=30)

print('=== Checking iframe-host deployment ===\n')

print('1. Files in /root:')
stdin, stdout, stderr = client.exec_command('ls -la /root/')
output = stdout.read().decode('utf-8', errors='ignore')
for line in output.split('\n'):
    if 'iframe' in line.lower() or 'internal' in line.lower():
        print(line)

print('\n2. Nginx config for internal-content:')
stdin, stdout, stderr = client.exec_command('cat /etc/nginx/conf.d/*.conf | grep -A 5 internal-content')
print(stdout.read().decode('utf-8', errors='ignore')[:500])

print('\n3. Port 3030 status:')
stdin, stdout, stderr = client.exec_command('netstat -tlnp | grep 3030')
print(stdout.read().decode('utf-8', errors='ignore'))

print('\n4. PM2 processes:')
stdin, stdout, stderr = client.exec_command('pm2 list | grep -E "name|iframe|internal"')
print(stdout.read().decode('utf-8', errors='ignore'))

client.close()
