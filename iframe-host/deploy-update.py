#!/usr/bin/env python3
"""Deploy updated server.js to remove /health endpoint"""

import subprocess
import sys

HOST = "root@50.114.113.121"
PORT = "29710"
REMOTE_DIR = "/root/iframe-host"

def run(cmd):
    print(f">>> {cmd}")
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"ERROR: {result.stderr}")
        sys.exit(1)
    if result.stdout:
        print(result.stdout)
    return result.stdout

def main():
    print("Deploying updated server.js (removing /health endpoint)...")

    # Upload new server.js
    run(f'scp -P {PORT} server.js {HOST}:{REMOTE_DIR}/')

    # Restart the service
    run(f'ssh -p {PORT} {HOST} "cd {REMOTE_DIR} && pm2 restart iframe-host"')

    print("\nDeployment complete!")
    print("The /health endpoint has been removed.")
    print("Verify at: http://50.114.113.121/health (should return 404 or proxy response)")

if __name__ == "__main__":
    main()
