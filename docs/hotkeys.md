# Hotkeys & Wake Word Guide

Quilly is designed to be invisible until you need it. A single keystroke — or a spoken wake word — triggers dictation from anywhere in Windows.

## Default hotkeys

| Hotkey | What it does |
|---|---|
| `Ctrl + Alt + V` | **Transcribe only** — Whisper converts your speech to raw text and pastes it at your cursor |
| `Ctrl + Alt + P` | **Transcribe + AI polish** — your speech is transcribed by Whisper, then reshaped by a local AI model before pasting |

Press the hotkey once to **start**, press again to **stop**. The indicator floats next to your cursor while recording.

## How to use each mode

### Transcribe only (`Ctrl + Alt + V`)

Best for: faithful, literal dictation. Your words appear exactly as Whisper heard them.

**Example flow:**
1. Click into any text field — email, chat, Word, terminal, anything
2. Press `Ctrl + Alt + V` — a small red pill appears near your cursor
3. Speak your message at a natural pace
4. Press `Ctrl + Alt + V` again to stop
5. After a brief transcribing animation, your text is pasted

### Transcribe + AI polish (`Ctrl + Alt + P`)

Best for: rough thoughts, messy first drafts, or giving AI an instruction.

Quilly recognizes if you start with an instruction. Try any of these:

| What you say | What Quilly does |
|---|---|
| "Translate to Spanish: I'll be there at three." | Translates: *"Estaré allí a las tres."* |
| "Fix the grammar: me and jim is going to store tomorrow" | Rewrites: *"Jim and I are going to the store tomorrow."* |
| "Make this formal: hey what's up wanna grab coffee" | Rewrites: *"Hello — would you like to grab coffee?"* |
| "Summarize: [long rant about a project]" | Compresses to a clean summary |
| "What's the capital of Sweden?" | Answers: *"Stockholm."* |
| "Rewrite this as bullet points: [speech]" | Formats as a list |

No instruction? Quilly still cleans up fillers ("um", "uh"), fixes obvious grammar, and preserves your intent.

## Customizing hotkeys

1. Open Quilly's Dashboard (click the tray icon or the desktop shortcut)
2. Go to **Settings → Hotkeys**
3. Click the field for either action and press your new key combination
4. Click **Save**

**Supported modifiers:** `Ctrl`, `Alt`, `Shift`, `Win` (Windows key) — any combination.

**Reserved combinations to avoid:**
- `Ctrl + C`, `Ctrl + V`, `Ctrl + X`, `Ctrl + Z` (system clipboard/undo)
- `Win + D`, `Win + E`, `Win + L` (Windows OS reserved)
- Anything your other software already uses

If Quilly's hotkey conflicts with another app, one of them won't register. Pick something unusual — `Ctrl + Alt + [letter]` is a safe zone.

## Wake word (hands-free activation)

Don't want to press a hotkey? Turn on the wake word and just **say it**.

### Enable the wake word

1. Dashboard → Settings → **Wake Word**
2. Toggle **Enable wake word** on
3. Set your preferred wake word (default is **"Quilly"**)
4. Choose a sensitivity level (Standard is recommended)
5. Save

### How it works

When the wake word is enabled, Quilly listens continuously (on your device — nothing leaves your machine). When it hears your word, it starts recording automatically, as if you'd pressed the hotkey.

**Example:**
> *"Quilly — send a message to the team saying we're running ten minutes late."*

- "Quilly" is the wake word — Quilly starts listening
- Everything after it is treated as your dictation
- After a short pause of silence, Quilly stops and processes

### Picking a good wake word

- **Short** — one or two syllables work best
- **Distinctive** — avoid common words you say all day ("hey", "yes", "sure")
- **Not a name of a person you talk to regularly**

Great choices: *Quilly*, *Echo*, *Astra*, *Pixel*, *Cosmo*, *Nova*. Any word you like works.

### Turning off continuous listening

If you don't want Quilly always listening:

- Disable the wake word (Dashboard → Settings → Wake Word → off)
- Or right-click the tray icon → **Mute wake word** for a quick toggle

The hotkey still works even with the wake word off.

## Tips for best results

- **Speak at a normal pace** — no need to over-enunciate. Whisper is trained on natural speech.
- **Short pauses are fine** — Whisper handles them. Long silences may cause Quilly to stop listening.
- **Noisy environment?** A headset mic gives much cleaner results than a built-in laptop mic.
- **Transcribe before polish** — if you're not happy with the AI polish, re-run with `Ctrl + Alt + V` to get the raw Whisper output.
- **The indicator follows your cursor** — move the cursor if the pill is in a distracting spot; it'll move with you.

## Canceling mid-recording

- **Press the hotkey a third time** while recording — Quilly stops and discards the recording
- Or click the cancel button on the indicator pill (if visible)
- Or press `Esc` while the indicator has focus

## Still stuck?

See [Troubleshooting](troubleshooting.md) or [open an issue](https://github.com/alfredorr-ARTRs-pro/Quilly/issues).
