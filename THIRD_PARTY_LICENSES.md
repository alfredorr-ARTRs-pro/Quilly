# Third-Party Licenses

Quilly is built on a foundation of excellent open-source software. This document lists the major third-party components bundled with or used by Quilly and their respective licenses.

## AI models and inference engines

| Project | License | Purpose |
|---|---|---|
| **[whisper.cpp](https://github.com/ggml-org/whisper.cpp)** by Georgi Gerganov / ggml-org | [MIT](https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE) | Speech-to-text inference engine, incl. `parakeet-cli` (downloaded on first use) |
| **[llama.cpp](https://github.com/ggml-org/llama.cpp)** by Georgi Gerganov / ggml-org | [MIT](https://github.com/ggml-org/llama.cpp/blob/master/LICENSE) | Language-model inference engine, `llama-server` (downloaded on first use) |
| **[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)** by k2-fsa | [Apache 2.0](https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE) | Speaker diarization engine (downloaded on first use) |
| **[Whisper](https://github.com/openai/whisper)** by OpenAI | [MIT](https://github.com/openai/whisper/blob/main/LICENSE) | Speech recognition model weights (downloaded on first use) |
| **[Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)** by NVIDIA | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) | Speech recognition model weights, GGML conversion by [ggml-org](https://huggingface.co/ggml-org/parakeet-GGUF) (downloaded on first use) |
| **[Qwen](https://github.com/QwenLM/Qwen)** by Alibaba Cloud | [Apache 2.0](https://github.com/QwenLM/Qwen/blob/main/LICENSE) | Language model weights (downloaded on first use) |
| **[pyannote segmentation 3.0](https://huggingface.co/pyannote/segmentation-3.0)** by pyannote | [MIT](https://github.com/pyannote/pyannote-audio/blob/develop/LICENSE) | Speaker segmentation model, ONNX export via sherpa-onnx (downloaded on first use) |
| **[TitaNet-S](https://catalog.ngc.nvidia.com/orgs/nvidia/nemo/models/titanet_small)** by NVIDIA | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) | Speaker embedding model, ONNX export via sherpa-onnx (downloaded on first use) |

### Model weight redistribution

Quilly does **not** bundle any model weights or engine programs in its installer. They are downloaded on first use from their official sources (Hugging Face and GitHub). Users retain full responsibility for compliance with the respective licenses when using them. Parakeet and TitaNet are © NVIDIA Corporation, used under CC-BY-4.0 in the converted formats linked above; Quilly does not modify them further.

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
