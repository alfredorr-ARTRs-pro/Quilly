# Third-Party Licenses

Quilly is built on a foundation of excellent open-source software. This document lists the major third-party components bundled with or used by Quilly and their respective licenses.

## AI models and inference engines

| Project | License | Purpose |
|---|---|---|
| **[whisper.cpp](https://github.com/ggerganov/whisper.cpp)** by Georgi Gerganov | [MIT](https://github.com/ggerganov/whisper.cpp/blob/master/LICENSE) | Speech-to-text inference engine (bundled binary) |
| **[llama.cpp](https://github.com/ggerganov/llama.cpp)** by Georgi Gerganov | [MIT](https://github.com/ggerganov/llama.cpp/blob/master/LICENSE) | Language-model inference engine (bundled as `llama-server`) |
| **[Whisper](https://github.com/openai/whisper)** by OpenAI | [MIT](https://github.com/openai/whisper/blob/main/LICENSE) | Speech recognition model weights (downloaded on first use) |
| **[Qwen](https://github.com/QwenLM/Qwen)** by Alibaba Cloud | [Apache 2.0](https://github.com/QwenLM/Qwen/blob/main/LICENSE) | Language model weights (downloaded on first use) |

### Model weight redistribution

Quilly does **not** bundle the Whisper or Qwen model weights in its installer. They are downloaded on first use from their official repositories (HuggingFace). Users retain full responsibility for compliance with the respective model licenses when using those weights.

## Application framework

| Project | License | Purpose |
|---|---|---|
| **[Electron](https://electronjs.org)** | [MIT](https://github.com/electron/electron/blob/main/LICENSE) | Desktop application framework |
| **[React](https://react.dev)** | [MIT](https://github.com/facebook/react/blob/main/LICENSE) | User interface library |
| **[Vite](https://vitejs.dev)** | [MIT](https://github.com/vitejs/vite/blob/main/LICENSE) | Build tool |
| **[React Router](https://reactrouter.com)** | [MIT](https://github.com/remix-run/react-router/blob/main/LICENSE.md) | Client-side routing |

## Runtime dependencies

| Project | License | Purpose |
|---|---|---|
| **[@huggingface/transformers](https://github.com/huggingface/transformers.js)** | [Apache 2.0](https://github.com/huggingface/transformers.js/blob/main/LICENSE) | Model loading utilities |
| **[onnxruntime-node](https://github.com/microsoft/onnxruntime)** | [MIT](https://github.com/microsoft/onnxruntime/blob/main/LICENSE) | ONNX model runtime |
| **[electron-store](https://github.com/sindresorhus/electron-store)** | [MIT](https://github.com/sindresorhus/electron-store/blob/main/license) | Persistent settings storage |
| **[auto-launch](https://github.com/Teamwork/node-auto-launch)** | [Apache 2.0](https://github.com/Teamwork/node-auto-launch/blob/master/LICENSE) | Startup-with-Windows helper |
| **[wavesurfer.js](https://github.com/katspaugh/wavesurfer.js)** | [BSD-3-Clause](https://github.com/katspaugh/wavesurfer.js/blob/main/LICENSE) | Audio waveform visualization |
| **[adm-zip](https://github.com/cthackers/adm-zip)** | [MIT](https://github.com/cthackers/adm-zip/blob/master/LICENSE) | ZIP archive handling |
| **[check-disk-space](https://github.com/Alex-D/check-disk-space)** | [MIT](https://github.com/Alex-D/check-disk-space/blob/master/LICENSE) | Free-disk-space detection |

## Build-time dependencies

| Project | License |
|---|---|
| **[electron-builder](https://github.com/electron-userland/electron-builder)** | [MIT](https://github.com/electron-userland/electron-builder/blob/master/LICENSE) |
| **[ESLint](https://eslint.org)** | [MIT](https://github.com/eslint/eslint/blob/main/LICENSE) |
| **[@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react)** | [MIT](https://github.com/vitejs/vite-plugin-react/blob/main/LICENSE) |

## Full license texts

The full text of every transitive dependency's license ships inside the `node_modules` directory in the source tree, and is included in the installer's `resources/app.asar` bundle per each license's redistribution terms.

To audit every dependency's license in the built installer, run:

```bash
npx license-checker --production --summary
```

## Reporting a license issue

If you believe a component is being used in a way that violates its license, please open an issue at [github.com/alfredorr-ARTRs-pro/Quilly/issues](https://github.com/alfredorr-ARTRs-pro/Quilly/issues) or report it privately via the Security tab.
