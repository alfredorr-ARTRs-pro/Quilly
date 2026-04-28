# Install Guide

Full walkthrough of installing Quilly on Windows 10 or 11.

## Before you start

- **Windows 10 (64-bit) or Windows 11** — Quilly is Windows-only for now
- **~2 GB free disk space** for the app and a basic Whisper model (more if you want the larger AI models)
- **A microphone** — any Windows-recognized mic works (built-in, USB, Bluetooth, headset)

Internet access is only needed the first time you download an AI model. After that, Quilly runs fully offline.

## Step 1 — Download the installer

1. Go to the **[Quilly Releases page](https://github.com/alfredorr-ARTRs-pro/Quilly/releases)**
2. Find the latest release at the top
3. Click `Quilly-V-X.X.X-Setup.exe` under **Assets** to download

## Step 2 — Run the installer

Double-click the downloaded `.exe`.

### About the SmartScreen warning

Quilly's installer isn't code-signed yet (that's coming — via [SignPath Foundation](https://signpath.org)). Until then, Windows Defender SmartScreen will show:

> **Windows protected your PC**
> Microsoft Defender SmartScreen prevented an unrecognized app from starting.

This is a normal warning for any unsigned open-source Windows app. To continue:

1. Click **More info**
2. Click **Run anyway**

That's it — the installer will then launch.

### Why does Windows warn me?

SmartScreen checks whether a downloaded app has been "seen before" by Microsoft on many machines. A brand-new or niche installer lacks reputation, so Windows plays it safe. Once enough people install a signed version of Quilly, the warning disappears.

**Quilly is fully open-source** — you can [read every line of code](https://github.com/alfredorr-ARTRs-pro/Quilly) yourself, and you can [verify the installer's SHA-256 hash](#verify-your-download) before running.

## Step 3 — Complete the install

The installer is a standard Windows NSIS installer. You'll see:

1. **License agreement** (MIT) — click Agree
2. **Install location** — accept the default or pick a custom folder
3. **Start menu shortcut** — recommended to keep enabled
4. **Desktop shortcut** — optional
5. Click **Install**

When it's done, Quilly will launch automatically.

## Step 4 — First launch

On first launch, Quilly will:

1. **Open the Dashboard** — the main settings window
2. **Ask to download a Whisper model** — the speech-to-text brain. Small (~466 MB) is recommended for the best balance of speed, accuracy, and disk use. You can switch to a larger model later if you want higher accuracy. This happens once; after download, it works offline.
3. **Ask about optional AI polishing** — if you enable it, you can later download a Qwen model for AI-rewrite features.

All downloads happen in the background. You can keep using Quilly while they finish.

## Step 5 — Configure auto-launch (optional)

In the Dashboard → Settings:

- Toggle **"Start with Windows"** — Quilly will launch quietly into the system tray every time you log in.

Quilly is designed to live in the system tray and activate via hotkey — so once installed, you rarely need to open the Dashboard.

## Verify your download

Every release publishes a **SHA-256 hash** next to the installer. To verify:

1. Download the `.sha256` file from the release page alongside the installer
2. Open **PowerShell** and run:

   ```powershell
   Get-FileHash -Algorithm SHA256 Quilly-V-1.2.0-Setup.exe
   ```

3. Compare the output hash against the one in the `.sha256` file

If they match: the installer is genuine. If they don't match: **do not run it** — report it via [Issues](https://github.com/alfredorr-ARTRs-pro/Quilly/issues).

## Uninstall

Windows **Settings → Apps → Installed apps** → find **Quilly** → click the three dots → **Uninstall**.

By default, your transcription history and AI models are **preserved** for reinstallation. To fully remove them:

1. After uninstalling, open `%APPDATA%\Quilly` in File Explorer (copy that path into the address bar)
2. Delete the entire folder

## Trouble with installation?

See the [Troubleshooting Guide](troubleshooting.md) or [open an issue](https://github.com/alfredorr-ARTRs-pro/Quilly/issues).
