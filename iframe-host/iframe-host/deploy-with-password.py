#!/usr/bin/env python3
"""Deploy updated server.js with password authentication"""

import paramiko
import sys

HOST = "50.114.113.121"
PORT = 22
USERNAME = "root"
PASSWORD = "PaSdf5z8b3t2SaZdFdj2"
REMOTE_DIR = "/root/iframe-host"
LOCAL_FILE = "server.js"  # Must run from iframe-host directory

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
        print(f"\nUploading {LOCAL_FILE} to {REMOTE_DIR}/...")
        sftp = client.open_sftp()
        remote_file = f"{REMOTE_DIR}/server.js"
        sftp.put(LOCAL_FILE, remote_file)
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
        print("The /health endpoint should now be removed.")
        print("Verify at: http://50.114.113.121/health")

        client.close()

    except FileNotFoundError:
        print(f"ERROR: {LOCAL_FILE} not found. Make sure to run this script from the iframe-host directory.")
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()
