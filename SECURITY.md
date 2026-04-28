# Security Policy

## Supported versions

Quilly is actively developed. Security fixes are provided for the **latest released version** only. If you're running an older version, please update before reporting a vulnerability.

| Version | Supported |
|---|---|
| Latest release | Yes |
| Older releases | No |

## Reporting a vulnerability

**Please do not report security vulnerabilities in public GitHub issues.**

Instead, use one of these private channels:

### Preferred: GitHub Private Vulnerability Reporting

1. Go to the **[Security tab](https://github.com/alfredorr-ARTRs-pro/Quilly/security)** of this repository
2. Click **"Report a vulnerability"**
3. Fill in the form — your report stays private between you and the maintainer

This is the fastest and most secure way to report.

### Alternative: email

If GitHub's reporting is unavailable, email **security@aips.studio** with:
- A clear description of the vulnerability
- Steps to reproduce
- Affected version(s)
- Any suggested mitigation

## What to expect

- **Acknowledgement** within 72 hours
- **Initial assessment** within 7 days
- **Fix or mitigation plan** within 30 days for critical issues

Please give reasonable time for a fix to be prepared and released before public disclosure. Coordinated disclosure is appreciated.

## Scope

Quilly is a local desktop application. Its attack surface includes:

- The packaged binary (installer, executable, bundled native binaries)
- Local IPC between the Electron main process and renderer
- File handling of audio recordings and transcription output
- Model-file downloads from HuggingFace on first use
- The auto-launch / system-tray integration

**Out of scope:**

- Vulnerabilities in third-party dependencies (report those upstream)
- Physical access attacks on the user's machine
- Social-engineering attacks
- Issues in self-built versions that diverge from the official release

## Acknowledgements

Responsible disclosures are publicly credited (with permission) in release notes.

Thank you for helping keep Quilly users safe.
