#!/usr/bin/env python3
"""Deploy updated server.js with password authentication"""

import paramiko
import sys
import os

HOST = "50.114.113.121"
PORT = 22
USERNAME = "root"
PASSWORD = "PaSdf5z8b3t2SaZdFdj2"
REMOTE_DIR = "/root/iframe-host"

def main():
    print("Connecting to server...")

    try:
        # Create SSH client
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

        # Connect
        client.connect(HOST, port=PORT, username=USERNAME, password=PASSWORD, timeout=30)
        print("OK Connected successfully")

        # Check if /health endpoint exists in current server.js
        print("\nChecking current server.js on remote...")
        stdin, stdout, stderr = client.exec_command(f"grep -n 'health' {REMOTE_DIR}/server.js")
        health_check = stdout.read().decode()
        if health_check:
            print(f"Found /health endpoint in remote server.js:\n{health_check}")
        else:
            print("No /health endpoint found in remote server.js")

        # Upload new server.js
        print("\nUploading updated server.js...")
        sftp = client.open_sftp()
        local_file = os.path.join(os.path.dirname(__file__), "server.js")
        remote_file = f"{REMOTE_DIR}/server.js"
        sftp.put(local_file, remote_file)
        sftp.close()
        print("OK File uploaded")

        # Restart service
        print("\nRestarting iframe-host service...")
        stdin, stdout, stderr = client.exec_command(f"cd {REMOTE_DIR} && pm2 restart iframe-host")
        output = stdout.read().decode()
        error = stderr.read().decode()
        if output:
            print(output)
        if error:
            print(f"stderr: {error}")

        print("\nOK Deployment complete!")
        print("The /health endpoint has been removed (if it existed).")
        print("Verify at: http://50.114.113.121/health (should not return health check response)")

        client.close()

    except Exception as e:
        print(f"ERROR: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
