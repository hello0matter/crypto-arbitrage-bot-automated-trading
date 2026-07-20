#!/usr/bin/env python3
"""Remove /health endpoint from card_server"""

import paramiko

HOST = "50.114.113.121"
PORT = 22
USERNAME = "root"
PASSWORD = "PaSdf5z8b3t2SaZdFdj2"

def exec_cmd(client, cmd):
    stdin, stdout, stderr = client.exec_command(cmd)
    return stdout.read().decode(), stderr.read().decode()

def main():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USERNAME, password=PASSWORD, timeout=30)

    print("Removing /health endpoint from card_server...")

    # Backup
    exec_cmd(client, "cp /root/card_server/server.js /root/card_server/server.js.bak")
    print("OK Created backup")

    # Remove lines 81-83 (the /health endpoint)
    exec_cmd(client, "sed -i '81,83d' /root/card_server/server.js")
    print("OK Removed /health endpoint (lines 81-83)")

    # Remove health from logging check (line 62)
    exec_cmd(client, "sed -i \"62s/!== '\\/health'/!== 'xxxNEVERxxx'/\" /root/card_server/server.js")
    print("OK Updated logging filter")

    # Verify
    print("\nVerifying changes...")
    out, _ = exec_cmd(client, "grep -n health /root/card_server/server.js")
    if out.strip():
        print(f"WARNING: health still found:\n{out}")
    else:
        print("OK No health references found")

    # Restart
    print("\nRestarting card_server...")
    out, _ = exec_cmd(client, "pm2 restart card_server")
    print(out)

    client.close()
    print("\nDeployment complete!")
    print("The /health endpoint has been removed from card_server.")
    print("Verify at: http://50.114.113.121/health")

if __name__ == "__main__":
    main()
