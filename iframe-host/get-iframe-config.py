#!/usr/bin/env python3
import paramiko

HOST = "50.114.113.121"
PORT = 22
USERNAME = "root"
PASSWORD = "PaSdf5z8b3t2SaZdFdj2"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=PORT, username=USERNAME, password=PASSWORD, timeout=30)

print('Checking iframe-host configuration...')
stdin, stdout, stderr = client.exec_command('find /root -name config.json -type f 2>/dev/null')
files = stdout.read().decode('utf-8')
print('Config files found:')
print(files)

if '/root/iframe-host/config.json' in files:
    print('\nReading /root/iframe-host/config.json...')
    stdin, stdout, stderr = client.exec_command('cat /root/iframe-host/config.json')
    config = stdout.read().decode('utf-8')
    print(config)

client.close()
