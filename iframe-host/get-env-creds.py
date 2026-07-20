#!/usr/bin/env python3
import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('50.114.113.121', port=22, username='root', password='PaSdf5z8b3t2SaZdFdj2', timeout=30)

print('=== iframe-host Admin Credentials ===\n')
stdin, stdout, stderr = client.exec_command('cat /etc/iframe-host/iframe-host.env')
env_content = stdout.read().decode('utf-8', errors='ignore')

print(env_content)

# Parse credentials
admin_username = None
admin_password = None
admin_path = None

for line in env_content.split('\n'):
    if line.startswith('ADMIN_USERNAME='):
        admin_username = line.split('=', 1)[1].strip().strip('"')
    elif line.startswith('ADMIN_PASSWORD='):
        admin_password = line.split('=', 1)[1].strip().strip('"')
    elif line.startswith('ADMIN_PATH='):
        admin_path = line.split('=', 1)[1].strip().strip('"')

print('\n' + '='*60)
print('Extracted Credentials:')
print('='*60)
print(f'Admin URL: http://50.114.113.121/{admin_path}/')
print(f'Username: {admin_username}')
print(f'Password: {admin_password}')
print('='*60)

client.close()
