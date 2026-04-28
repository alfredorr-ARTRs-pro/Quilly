# Troubleshooting Guide

Common issues and how to solve them. If nothing here helps, [open an issue](https://github.com/alfredorr-ARTRs-pro/Quilly/issues) with your symptoms and Windows version.

## Install issues

### "Windows protected your PC" when running the installer

**Expected** — the installer isn't code-signed yet. Click **More info → Run anyway**. See the [Install Guide](install.md#about-the-smartscreen-warning) for the full explanation.

### "This app can't run on your PC"

- Confirm you're on **Windows 10 (64-bit) or Windows 11**. 32-bit Windows isn't supported.
- Confirm you downloaded `Quilly-V-X.X.X-Setup.exe` (not a source zip).

### Installer hangs at "Extracting files"

- Antivirus software (particularly enterprise / 3rd-party AVs) can scan large installers and cause pauses. Wait a couple of minutes.
- If it still hangs after 5+ minutes, cancel, re-download the installer, and try again.

### "Invalid signature" or "hash mismatch"

- Your download may be corrupted or tampered with. Re-download from the [official Releases page](https://github.com/alfredorr-ARTRs-pro/Quilly/releases) and verify the SHA-256 matches what's published.

## Recording issues

### Nothing happens when I press the hotkey

1. **Is Quilly running?** Check the system tray (bottom-right of your screen, near the clock). You should see a small Quilly icon. If not, launch Quilly from the Start menu.
2. **Is another app using the same hotkey?** Some other tools (screenshot apps, macros, gaming overlays) might grab `Ctrl + Alt + V`. Try changing Quilly's hotkey in Settings → Hotkeys to something unusual.
3. **Is Windows blocking global hotkeys?** Some anti-cheat or security software blocks global hotkey registration. Whitelist Quilly in your security software.

### Microphone not detected / no audio captured

1. **Windows mic permissions:** Settings → Privacy & Security → Microphone → ensure **"Let desktop apps access your microphone"** is **On**.
2. **Default mic:** Windows Settings → System → Sound → under Input, confirm the correct mic is set as default. Try speaking — you should see the input bar move.
3. **In Quilly:** Dashboard → Settings → Audio → pick your mic explicitly from the dropdown.

### Recording indicator appears but no timer / stuck on "preparing"

- The microphone stream may be locked by another app (e.g., Zoom, Teams, Discord with their mic open).
- Close other apps that might be using the mic, then try again.
- If the indicator is still stuck, click the "×" on the indicator or press the hotkey to cancel, then try again.

### Transcription is empty or wrong

- **Speech too quiet** — boost your mic input volume in Windows Sound settings.
- **Background noise** — try a headset mic; built-in laptop mics pick up a lot.
- **Whisper model too small** — switch to a larger model (Settings → AI Models → Whisper → Medium or Large v3).
- **Accent / unusual language** — Whisper handles most languages but accuracy varies. Larger models help.

## AI polish issues

### AI polish hotkey does nothing

- You need a **Qwen model downloaded**. Settings → AI Models → Language Model → Enable AI Processing → Download.
- The first run after download takes longer because the model loads into memory. Subsequent runs are faster.

### AI polish is extremely slow

- You're likely running **Qwen on CPU**, which is slow.
- Switch to the smaller **Qwen 4B** (Settings → AI Models → Language Model).
- If you have an NVIDIA GPU with CUDA 12.4+, make sure **Inference Mode is set to Auto or GPU** (Settings → Performance).
- Close other RAM-hungry apps — Qwen 9B needs 16 GB+ RAM free.

### AI polish produces weird or nonsensical output

- Try phrasing your dictation more clearly or giving a clearer instruction.
- Some instructions work better than others — e.g., "Translate to Spanish:" is very explicit; "Make it better" is vague.
- Switch to the larger **Qwen 9B** if you're on Qwen 4B.

### GPU mode fails or errors out

- Your CUDA version may be below 12.4. Run `nvidia-smi` in Command Prompt and check the CUDA Version in the output.
- If it's below 12.4, update your NVIDIA drivers from [nvidia.com/drivers](https://www.nvidia.com/drivers).
- If your GPU is an older model without CUDA 12.4 support, use CPU mode instead (Settings → Performance → Inference Mode → CPU).

## Paste / output issues

### Text doesn't paste into my app

- Click into the target text field **before** pressing the hotkey — Quilly pastes wherever your cursor is when you stop recording.
- Some apps block simulated paste (e.g., password fields, secure text inputs). Try a different app to confirm Quilly works.
- Make sure the target app still has focus after your recording finishes. If you clicked away during transcribing, Quilly may paste into the wrong place.

### Text appears in the wrong app

- You clicked away from your original app during the transcribe/polish phase. Quilly pastes into whatever has focus when it's done.
- Solution: stay focused on the target field while Quilly processes.

### Transcription appears slowly, letter by letter

- That's the paste simulation — Quilly types the text into your target app rather than pasting the clipboard (which many apps block).
- You can change this in Settings → Output → Paste Mode.

## Performance issues

### Quilly uses a lot of RAM / CPU

- The AI models (especially Qwen 9B) use significant RAM. If you don't need AI polish, disable it in Settings.
- Use smaller models if your machine is struggling.
- Close other AI or GPU-heavy apps when using Quilly.

### Windows says my disk is full after using Quilly

- Audio recordings accumulate in `%APPDATA%\Quilly\`. Dashboard → History → Clear old recordings.
- Old AI models can be deleted: `%LOCALAPPDATA%\Quilly\models\` — delete models you're not using.

## Wake word issues

### Wake word isn't triggering

- Settings → Wake Word → confirm it's **enabled**.
- Pick a more distinctive wake word — common English words might be missed.
- Try increasing sensitivity.
- Check that your mic is still working (see Microphone section above).

### Wake word triggers when I don't want it to

- Your chosen word appears too often in your daily speech. Pick a more unique one (see [Hotkeys Guide](hotkeys.md#picking-a-good-wake-word)).
- Lower sensitivity in Settings.
- Or disable wake word and use the hotkey only.

## System tray / tray icon issues

### Quilly doesn't appear in the system tray

- The tray icon might be hidden — click the **upward arrow (`^`)** in the tray area to see hidden icons.
- Right-click the taskbar → Taskbar settings → Other system tray icons → ensure Quilly is toggled **On**.

### Clicking the tray icon does nothing

- Recent Quilly versions should reopen the Dashboard on tray click. If yours doesn't, update to the latest release.

## Uninstall issues

### Quilly keeps running after uninstalling

- The uninstaller should kill the process, but if a leftover is running: open Task Manager (`Ctrl + Shift + Esc`) → find Quilly under Processes → End task.
- Then re-run the uninstaller or manually delete `%APPDATA%\Quilly\` and `%LOCALAPPDATA%\Quilly\`.

### I want to keep my history but reinstall

- The default install keeps `%APPDATA%\Quilly\` (history) and `%LOCALAPPDATA%\Quilly\models\` (AI models) intact. Just reinstall — your data and models will be picked up automatically.

## Still stuck?

- **Check [existing issues](https://github.com/alfredorr-ARTRs-pro/Quilly/issues)** — your problem may be known.
- **[Open a new issue](https://github.com/alfredorr-ARTRs-pro/Quilly/issues/new/choose)** — include:
  - Your Quilly version (Dashboard → About)
  - Windows version
  - What you were trying to do
  - What actually happened
  - Screenshot or log excerpt if relevant
- **[Ask in Discussions](https://github.com/alfredorr-ARTRs-pro/Quilly/discussions)** — if you're not sure it's a bug.

For anything urgent or security-related, use the **[Security Advisory](https://github.com/alfredorr-ARTRs-pro/Quilly/security/advisories/new)** form (private).
