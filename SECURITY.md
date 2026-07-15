# Security baseline

This repository contains demonstration Python modules. It does not contain the
`CortexLauncher.exe` referenced by external links in the README.

## Before using this repository

- Do not run binaries downloaded from external sites merely because they are
  linked from documentation.
- Keep exchange API keys out of the repository and grant them read/trade access
  only; never enable withdrawal permissions for a bot key.
- Verify release provenance and SHA-256 values in an isolated environment.
- Review `.github/workflows/` before enabling Actions or granting repository
  secrets.

## Included controls

- `src/security.py` rejects non-HTTPS, credential-bearing, local, and reserved
  literal RPC endpoints supplied through environment variables.
- `tools/security_check.py` statically flags selected command execution,
  deserialization, workflow, and dependency risks without importing the bot.
- CI runs the checker before installing dependencies and uses read-only GitHub
  Actions permissions.

Run the local checks with:

```text
python tools/security_check.py --strict
python -m unittest discover -s tests -v
```
