#!/usr/bin/env python3
import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('50.114.113.121', port=22, username='root', password='PaSdf5z8b3t2SaZdFdj2', timeout=30)

print('Checking process on port 3030...')
stdin, stdout, stderr = client.exec_command('ps aux | grep 57307')
print(stdout.read().decode('utf-8', errors='ignore'))

print('\nChecking nginx reverse proxy config...')
stdin, stdout, stderr = client.exec_command('cat /etc/nginx/conf.d/*.conf 2>/dev/null')
config = stdout.read().decode('utf-8', errors='ignore')
if 'internal-content' in config:
    print('Found internal-content config:')
    for line in config.split('\n'):
        if 'internal-content' in line or 'proxy_pass' in line:
            print(line)
else:
    print('No internal-content config found')
    print('Config preview (first 1000 chars):')
    print(config[:1000])

client.close()
