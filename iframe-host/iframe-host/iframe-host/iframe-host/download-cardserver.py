#!/usr/bin/env python3
"""Add visitor tracking and behavior analytics to card_server"""

import paramiko
import sys

HOST = "50.114.113.121"
PORT = 22
USERNAME = "root"
PASSWORD = "PaSdf5z8b3t2SaZdFdj2"

def exec_cmd(client, cmd):
    stdin, stdout, stderr = client.exec_command(cmd)
    return stdout.read().decode('utf-8', errors='ignore'), stderr.read().decode('utf-8', errors='ignore')

def main():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USERNAME, password=PASSWORD, timeout=30)

    print("Downloading current server.js for analysis...")
    sftp = client.open_sftp()
    sftp.get('/root/card_server/server.js', 'card_server_current.js')
    sftp.close()
    print("OK Downloaded server.js")

    print("\nDownloading current admin.html...")
    sftp = client.open_sftp()
    sftp.get('/root/card_server/public/admin.html', 'admin_current.html')
    sftp.close()
    print("OK Downloaded admin.html")

    client.close()
    print("\nFiles downloaded. Ready for enhancement.")
    print("Next: Analyze and add tracking features")

if __name__ == "__main__":
    main()
