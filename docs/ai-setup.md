# AI Models & Setup Guide

Quilly uses two kinds of on-device AI models. This guide explains what each does, how to pick the right one, and how to set up GPU acceleration.

## What AI models does Quilly use?

Two independent models, each with a different job:

### 1. Whisper — speech-to-text (required)

Converts your spoken audio into text. This is what runs every time you use the hotkey.

Whisper is an open-source model by OpenAI ([github.com/openai/whisper](https://github.com/openai/whisper)) that's been widely adopted as the gold standard for speech recognition. Quilly runs it locally via [whisper.cpp](https://github.com/ggerganov/whisper.cpp) — no cloud, no API.

### 2. Qwen — language model (optional)

Takes the text Whisper produced and reshapes it: fixes grammar, translates, summarizes, answers questions, rewrites in a chosen style.

Qwen is an open-source LLM family by Alibaba Cloud ([github.com/QwenLM/Qwen](https://github.com/QwenLM/Qwen)). Quilly runs it locally via [llama.cpp](https://github.com/ggerganov/llama.cpp).

Qwen is only needed if you use the **AI-polish hotkey (`Ctrl + Alt + P`)**. If you only dictate with `Ctrl + Alt + V`, you never need Qwen at all.

## Choosing a Whisper model

Whisper comes in five sizes. Smaller = faster but less accurate. Larger = slower but more accurate.

| Model | Size | Speed | Accuracy | Use when |
|---|---|---|---|---|
| **Tiny** | ~75 MB | Blazing | Basic | You have a weak machine or very clear speech |
| **Base** | ~142 MB | Very fast | Good | A solid default on older hardware |
| **Small** (recommended) | ~466 MB | Fast | Very good | Best balance — light on disk, works well on most machines |
| **Medium** | ~1.5 GB | Moderate | Excellent | Step up when you want top accuracy and have 8 GB+ RAM |
| **Large v3** | ~3.1 GB | Slower | Best-in-class | You want the absolute best transcription, and you have the hardware |

### How to download / switch Whisper models

1. Dashboard → **Settings → AI Models → Whisper**
2. Click **Download** next to the model you want
3. Wait for the download to finish (one-time, cached locally)
4. Click **Use this model** to switch

You can install multiple models and switch between them depending on your mood or machine.

## Choosing a Qwen model (optional)

Qwen comes in two sizes for Quilly:

| Model | Size | RAM needed | GPU recommended? |
|---|---|---|---|
| **Qwen 4B** (Fast) | ~2.7 GB | 8 GB+ | Optional — runs fine on CPU |
| **Qwen 9B** (Quality) | ~5.7 GB | 16 GB+ | Strongly recommended |

### Which should you pick?

- **8 GB RAM, no GPU** → Qwen 4B. CPU-only, it'll take 5–15 seconds per response. Good enough for grammar fixes and short rewrites.
- **16 GB+ RAM, no GPU** → Qwen 9B on CPU is usable but slow (20–30 seconds). Consider 4B for daily use.
- **Any NVIDIA GPU with CUDA 12.4+** → Qwen 9B on GPU runs at ~40 tokens/second, virtually instant for most requests. This is the sweet spot.

### How to download Qwen

1. Dashboard → **Settings → AI Models → Language Model**
2. Click **Enable AI Processing** (top of the page)
3. Click **Download** next to Qwen 4B or Qwen 9B (or both)
4. Wait for the download — you can keep using Quilly for transcription in the meantime
5. Once downloaded, the **AI-polish hotkey** (`Ctrl + Alt + P`) becomes active

## GPU vs CPU

Quilly auto-detects an NVIDIA GPU with CUDA 12.4 or newer.

### If you have a supported GPU

- **Settings → Performance → Inference Mode → Auto (default)**
- Quilly uses the GPU automatically for much faster AI-polish responses
- Whisper also benefits on GPU, though it's fast enough on CPU for most people

### If you don't have a supported GPU (or you're not sure)

- Quilly falls back to CPU inference automatically
- CPU works fine for Whisper
- CPU is slower for Qwen but still usable, especially the 4B model

### Forcing a specific mode

In **Settings → Performance → Inference Mode**, you can force:

- **Auto** (recommended) — use GPU if available, else CPU
- **GPU** — require GPU; errors if unavailable
- **CPU** — always CPU, even if GPU is available

The CPU option is useful if your GPU is doing other heavy work (gaming, video editing) and you want Quilly out of the way.

## Checking your CUDA version

If you want to verify GPU acceleration will work:

1. Open **Command Prompt** (`Win + R` → type `cmd` → Enter)
2. Run:
   ```cmd
   nvidia-smi
   ```
3. Look for "CUDA Version" in the top-right. If it shows **12.4 or higher**, you're good.

If `nvidia-smi` isn't recognized, you either don't have an NVIDIA GPU or the drivers aren't installed. Get drivers from [nvidia.com/drivers](https://www.nvidia.com/drivers).

## Where are models stored?

Downloaded AI models live in:

```
%LOCALAPPDATA%\Quilly\models\
```

Paste that into File Explorer's address bar to see them.

You can delete model files here to free disk space — Quilly will re-download them from their official sources if you re-enable the model later.

## Does my data leave my machine?

**No, never.** Quilly's AI inference runs entirely locally.

The only network calls Quilly ever makes are:

1. **Downloading AI models** the first time you enable them — from HuggingFace (official Whisper and Qwen repositories)
2. **Checking for Quilly updates** (if you opt into update checks — currently disabled)

That's it. No telemetry. No analytics. No voice data transmission. No account required.

You can verify by inspecting the [source code](https://github.com/alfredorr-ARTRs-pro/Quilly) or by watching network traffic with a tool like Wireshark or Windows Firewall logs.

## Troubleshooting AI setup

- **Model won't download** — check your internet connection and free disk space. Retry from the Settings page.
- **AI polish is very slow** — you're likely running on CPU with a large model. Try Qwen 4B instead of 9B.
- **GPU mode errors** — your CUDA version may be older than 12.4. Update your NVIDIA drivers.
- **Model works, then stops working** — you may be running low on RAM. Close other heavy apps or switch to a smaller model.

Full troubleshooting in the [Troubleshooting Guide](troubleshooting.md).
