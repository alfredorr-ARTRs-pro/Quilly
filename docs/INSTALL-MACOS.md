# Installing Quilly on macOS

Quilly for macOS runs on **Apple Silicon Macs (M1 or newer) with macOS 12 Monterey or later**. Intel Macs are not supported.

## 1. Download and install

1. Go to the **[Releases page](https://github.com/alfredorr-ARTRs-pro/Quilly/releases)**
2. Download `Quilly-V-X.X.X-macOS-arm64.dmg` (latest version)
3. Open the dmg and drag **Quilly** into **Applications**

### Verify the download (optional but recommended)

Every release publishes a SHA-256 checksum next to the dmg. In Terminal:

```sh
shasum -a 256 ~/Downloads/Quilly-V-*-macOS-arm64.dmg
```

Compare the output against the matching `.sha256` file on the Releases page before installing.

## 2. First launch — Gatekeeper

Quilly isn't notarized by Apple yet (free open-source apps go through this step once an Apple Developer membership is in place), so macOS blocks the first launch:

> **"Quilly" Not Opened** — Apple could not verify "Quilly" is free of malware…

To open it anyway:

1. Click **Done** on the warning dialog
2. Open **System Settings → Privacy & Security**
3. Scroll down to the security section — you'll see *"Quilly" was blocked to protect your Mac*
4. Click **Open Anyway**, then confirm with **Open Anyway** again (you may be asked for your password)

You only need to do this once. Once notarization is in place, the warning will disappear from future releases.

> **Tip:** On macOS 14 Sonoma and earlier you can also right-click the app in Applications and choose **Open** for a shortcut version of the same flow. macOS 15 Sequoia removed that shortcut — use the System Settings route above.

## 3. Permissions

Quilly needs two permissions to do its job. Everything runs locally — these permissions never send data anywhere.

### Microphone (required)

The first time you start a recording, macOS asks for microphone access. Click **Allow**.

If you missed the prompt: **System Settings → Privacy & Security → Microphone** → enable **Quilly**.

### Accessibility (required for auto-paste)

Quilly types the transcribed text into whatever app you're using by simulating ⌘V. macOS requires Accessibility access for that:

1. Open **System Settings → Privacy & Security → Accessibility**
2. Enable **Quilly** in the list (click **+** and pick it from Applications if it's not listed)

Without this, transcription still works — the text lands on your clipboard and Quilly shows a notification — but you'll have to press **⌘V** yourself.

## 4. Quick start

1. Quilly lives in your **menu bar** (top-right)
2. Click into any text field — email, doc, chat, terminal, anything
3. Press **⌘⌥V** and speak
4. Press **⌘⌥V** again to stop — the text pastes where your cursor is
5. For AI-polished output (grammar fixes, translation, rewrites), use **⌘⌥P** instead

Hotkeys are customizable in Settings → Hotkeys.

## 5. AI models

Same as on Windows: Whisper speech models and optional Qwen language models download automatically on first use from their official HuggingFace repositories, checksum-verified. On Apple Silicon, inference is accelerated with **Metal** — no configuration needed.

## Troubleshooting

**"Quilly can't be opened" with no Open Anyway option.**
The dmg may have been re-downloaded partially. Delete the app, re-download the dmg, verify the checksum, and reinstall.

**Nothing pastes after transcription.**
Grant Accessibility access (section 3) — then try again. The text is always on the clipboard as a fallback: press ⌘V.

**No microphone prompt appeared.**
System Settings → Privacy & Security → Microphone → enable Quilly, then restart the app.

**The speech engine says it's using the fallback.**
The native macOS whisper.cpp engine downloads separately on first setup. If it isn't available yet for your version, Quilly automatically uses the built-in fallback engine — slower, but fully functional.

---

Built with care by [A.I.P.S.](https://aips.studio)
