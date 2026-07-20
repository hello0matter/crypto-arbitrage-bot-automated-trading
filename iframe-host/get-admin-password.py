#!/usr/bin/env python3
import paramiko
import json

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('50.114.113.121', port=22, username='root', password='PaSdf5z8b3t2SaZdFdj2', timeout=30)

print('Reading /opt/iframe-host/config.json...')
stdin, stdout, stderr = client.exec_command('cat /opt/iframe-host/config.json')
config_str = stdout.read().decode('utf-8', errors='ignore')

try:
    config = json.loads(config_str)
    print('\n=== iframe-host Admin Credentials ===')
    print(f"URL: http://50.114.113.121/internal-content-admin/")
    print(f"Username: {config.get('admin_username', 'admin')}")
    print(f"Password: {config.get('admin_password', 'NOT FOUND')}")
    print(f"\nProxy prefix: {config.get('proxy_prefix', '')}")
    print(f"Target URL: {config.get('target_url', '')}")
except Exception as e:
    print(f'Error parsing config: {e}')
    print('Raw config:')
    print(config_str)

client.close()
