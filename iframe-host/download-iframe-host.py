#!/usr/bin/env python3
"""Download iframe-host server.js and admin.html for enhancement"""

import paramiko
import sys

HOST = "50.114.113.121"
PORT = 22
USERNAME = "root"
PASSWORD = "PaSdf5z8b3t2SaZdFdj2"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=PORT, username=USERNAME, password=PASSWORD, timeout=30)

print('Downloading iframe-host files...\n')

sftp = client.open_sftp()

# Download server.js
print('1. Downloading server.js...')
sftp.get('/opt/iframe-host/server.js', 'iframe-host-server.js')
print('   OK server.js downloaded')

# Download admin.html
print('2. Downloading admin.html...')
sftp.get('/opt/iframe-host/public/admin.html', 'iframe-host-admin.html')
print('   OK admin.html downloaded')

# Download package.json to see dependencies
print('3. Downloading package.json...')
sftp.get('/opt/iframe-host/package.json', 'iframe-host-package.json')
print('   OK package.json downloaded')

sftp.close()
client.close()

print('\nFiles downloaded successfully!')
print('Ready for enhancement.')
