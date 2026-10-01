// whisper.cpp native backend — subprocess-based transcription
// Supports CUDA 12, CUDA 11, OpenBLAS, and CPU backends on Windows;
// Metal on macOS (Apple Silicon).
// Binary: <userData>/whisper-cpp/whisper-cli[.exe] (or main[.exe])
// Models: <userData>/whisper-cpp/models/ggml-<size>.bin
//
// Exports:
//   transcribe(audioData, options)       — transcribe audio in the detected/specified language
//   translateToEnglish(audioData, options) — translate audio to English using Whisper's built-in
//                                           --translate flag (PROC-06: no LLM needed, faster path)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { app } = require('electron');
const platformUtils = require('./platformUtils.cjs');

// Monotonic counter so two transcriptions starting in the same millisecond
// (e.g. transcribe + translateToEnglish) never share a temp WAV path.
let _tempFileCounter = 0;

// Whisper prompt bias — updated via setWhisperPrompt()
let _whisperPrompt = 'Quilly';

const setWhisperPrompt = (word) => {
    const trimmed = (word || 'Quilly').trim();
    _whisperPrompt = trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
};

// Model ID → GGML filename mapping
const MODEL_ID_TO_GGML = {
    'Xenova/whisper-tiny.en': 'ggml-tiny.en.bin',
    'Xenova/whisper-base':    'ggml-base.bin',
    'Xenova/whisper-small':   'ggml-small.bin',
    'Xenova/whisper-medium':  'ggml-medium.bin',
    'Xenova/whisper-large-v3':'ggml-large-v3.bin',
    // Turbo lives under onnx-community (no Xenova repo exists for it) —
    // the id doubles as the Transformers.js fallback model id.
    'onnx-community/whisper-large-v3-turbo': 'ggml-large-v3-turbo.bin',
    // NVIDIA Parakeet — runs via parakeet-cli.exe (shipped in the same
    // whisper.cpp ≥v1.9.0 release zips), NOT whisper-cli. No Transformers.js
    // fallback exists for it.
    'ggml-org/parakeet-tdt-0.6b-v3': 'ggml-parakeet-tdt-0.6b-v3-f16.bin',
};

/** Parakeet models use a different CLI, output format, and flag set. */
const isParakeetModel = (modelId) => String(modelId || '').includes('parakeet');

const getBasePath = () => path.join(app.getPath('userData'), 'whisper-cpp');
const getModelsPath = () => path.join(getBasePath(), 'models');

/**
 * Find the whisper.cpp binary — newer versions use whisper-cli,
 * older versions use main (.exe suffix on Windows).
 * The CUDA release zip extracts into a subdirectory (e.g. Release/),
 * so we search the base path and common subdirectories.
 */
const findBinary = () => {
    const base = getBasePath();
    const candidates = ['whisper-cli', 'main'].map(platformUtils.getBinaryName);
    const subdirs = ['', 'Release', 'bin'];
    for (const sub of subdirs) {
        for (const name of candidates) {
            const p = path.join(base, sub, name);
            if (fs.existsSync(p)) return p;
        }
    }
    return null;
};

/**
 * Find parakeet-cli — present in whisper.cpp release zips since v1.9.0.
 * Older installs won't have it until the backend is set up again.
 */
const findParakeetBinary = () => {
    const base = getBasePath();
    const subdirs = ['', 'Release', 'bin'];
    const name = platformUtils.getBinaryName('parakeet-cli');
    for (const sub of subdirs) {
        const p = path.join(base, sub, name);
        if (fs.existsSync(p)) return p;
    }
    return null;
};

/**
 * Find the GGML model file for a given model ID.
 */
const findModel = (modelId) => {
    const ggmlName = MODEL_ID_TO_GGML[modelId];
    if (!ggmlName) return null;
    const p = path.join(getModelsPath(), ggmlName);
    return fs.existsSync(p) ? p : null;
};

/**
 * Check if whisper.cpp is ready to use.
 * Parakeet models need parakeet-cli specifically (not whisper-cli).
 */
const isAvailable = (modelId) => {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return false;
    const binary = isParakeetModel(modelId) ? findParakeetBinary() : findBinary();
    return !!(binary && findModel(modelId));
};

/**
 * Read the .backend marker file written by the downloader.
 * Returns 'cuda12' | 'cuda11' | 'openblas' | 'cpu' | null.
 */
const getInstalledBackend = () => {
    try {
        const p = path.join(getBasePath(), '.backend');
        if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8').trim();
    } catch (_) {}
    return null;
};

/**
 * Get status info for the UI.
 * For Parakeet models the relevant binary is parakeet-cli.exe — reporting
 * whisper-cli here would show "Backend ready" while hiding the setup button
 * that installs the missing Parakeet engine.
 */
const getStatus = (modelId) => {
    const binaryPath = isParakeetModel(modelId) ? findParakeetBinary() : findBinary();
    const modelPath = modelId ? findModel(modelId) : null;
    return {
        available: !!(binaryPath && modelPath),
        binaryInstalled: !!binaryPath,
        binaryPath,
        modelPath,
        basePath: getBasePath(),
        modelsPath: getModelsPath(),
        installedBackend: getInstalledBackend(),
    };
};

/**
 * Convert Float32Array (16kHz mono, [-1,1]) to 16-bit PCM WAV buffer.
 */
const float32ToWav = (float32Array, sampleRate = 16000) => {
    const numChannels = 1;
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = float32Array.length * bytesPerSample;
    const buffer = Buffer.alloc(44 + dataSize);

    // RIFF header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);

    // fmt sub-chunk
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);           // sub-chunk size
    buffer.writeUInt16LE(1, 20);            // PCM format
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * blockAlign, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);

    // data sub-chunk
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    // Float32 [-1.0, 1.0] → Int16 [-32768, 32767]
    let offset = 44;
    for (let i = 0; i < float32Array.length; i++) {
        const sample = Math.max(-1, Math.min(1, float32Array[i]));
        const int16 = sample < 0 ? sample * 32768 : sample * 32767;
        buffer.writeInt16LE(Math.round(int16), offset);
        offset += 2;
    }
    return buffer;
};

/**
 * Run whisper.cpp as a subprocess and parse JSON output.
 */
const runWhisperCpp = (wavPath, modelPath, binaryPath, options = {}) => {
    return new Promise((resolve, reject) => {
        // whisper-cli defaults to 4 threads regardless of core count; scale to the
        // machine (capped — whisper gains little beyond 8 threads and we must not
        // starve the rest of the app).
        const threads = Math.min(8, Math.max(2, os.cpus().length - 2));
        const args = [
            '-m', modelPath,
            '-f', wavPath,
            '-l', options.language || 'auto',
            '-t', String(threads),
            '--output-json',
            '--prompt', _whisperPrompt,
        ];

        // Timestamped output is opt-in (speaker diarization needs real
        // segment offsets). The hotkey path keeps --no-timestamps: faster,
        // and its callers only read text.
        if (options.timestamps !== true) {
            args.push('--no-timestamps');
        }

        if (options.translate === true) {
            args.push('--translate');
        }

        console.log(`Running: ${binaryPath} ${args.join(' ')}`);

        // Set cwd to the binary's directory so CUDA DLLs are found
        const proc = spawn(binaryPath, args, {
            cwd: path.dirname(binaryPath),
            windowsHide: true,
        });

        let stderrOutput = '';
        proc.stderr.on('data', (chunk) => {
            stderrOutput += chunk.toString();
            if (stderrOutput.length > 8192) {
                stderrOutput = stderrOutput.slice(-4096);
            }
        });

        const timeoutMs = (options.timeout || 120) * 1000;
        const timer = setTimeout(() => {
            proc.kill();
            reject(new Error(`whisper.cpp timed out after ${options.timeout || 120}s`));
        }, timeoutMs);

        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`whisper.cpp exited with code ${code}: ${stderrOutput.slice(-500)}`));
                return;
            }

            // whisper.cpp writes JSON to <input_file>.json
            const jsonPath = wavPath + '.json';
            try {
                const raw = fs.readFileSync(jsonPath, 'utf-8');
                const result = JSON.parse(raw);
                resolve({ result, pid: proc.pid });
            } catch (e) {
                reject(new Error(`Failed to read whisper.cpp output: ${e.message}`));
            }
        });

        proc.on('error', (err) => {
            clearTimeout(timer);
            reject(new Error(`Failed to spawn whisper.cpp: ${err.message}`));
        });
    });
};

/**
 * Run parakeet-cli as a subprocess. Source-verified contract (v1.9.1,
 * examples/parakeet-cli/parakeet-cli.cpp): the transcript prints to stdout
 * exclusively; all banners/logs go to stderr; exit code 0 on success, 1 on
 * failure. No language / timestamp / prompt flags exist — Parakeet v3
 * auto-detects among its 25 European languages.
 */
const runParakeetCli = (wavPath, modelPath, binaryPath, options = {}) => {
    return new Promise((resolve, reject) => {
        const threads = Math.min(8, Math.max(2, os.cpus().length - 2));
        const args = [
            '-m', modelPath,
            '-f', wavPath,
            '-t', String(threads),
        ];

        console.log(`Running: ${binaryPath} ${args.join(' ')}`);

        const proc = spawn(binaryPath, args, {
            cwd: path.dirname(binaryPath),
            windowsHide: true,
        });

        let stdoutText = '';
        proc.stdout.on('data', (chunk) => {
            stdoutText += chunk.toString();
        });

        let stderrOutput = '';
        proc.stderr.on('data', (chunk) => {
            stderrOutput += chunk.toString();
            if (stderrOutput.length > 8192) {
                stderrOutput = stderrOutput.slice(-4096);
            }
        });

        const timeoutMs = (options.timeout || 120) * 1000;
        const timer = setTimeout(() => {
            proc.kill();
            reject(new Error(`parakeet-cli timed out after ${options.timeout || 120}s`));
        }, timeoutMs);

        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`parakeet-cli exited with code ${code}: ${stderrOutput.slice(-500)}`));
                return;
            }
            resolve({ text: stdoutText.trim(), pid: proc.pid });
        });

        proc.on('error', (err) => {
            clearTimeout(timer);
            reject(new Error(`Failed to spawn parakeet-cli: ${err.message}`));
        });
    });
};

// ─── Timeout scaling ──────────────────────────────────────────────────────────
// whisper.cpp runs as a subprocess with a kill timer (see runWhisperCpp). A
// fixed 120s ceiling starves long files: a 70-min recording cannot transcribe in
// 120s, so it always times out and falls back to the much slower Transformers.js
// CPU path — defeating the GPU exactly when it matters most. Scale the budget
// with audio length instead. whisper.cpp on GPU runs many times faster than
// realtime; even a CPU build rarely drops below ~0.5x realtime, so 2s of
// wall-clock per audio second is a safe, generous envelope while still capping a
// genuinely hung process. Short clips keep the original 120s floor.
const WHISPER_TIMEOUT_FLOOR_SECS = 120;
const WHISPER_TIMEOUT_PER_AUDIO_SEC = 2;

const computeWhisperTimeout = (durationSecs, options = {}) => {
    // An explicit, positive caller-supplied timeout always wins.
    if (options && Number.isFinite(options.timeout) && options.timeout > 0) {
        return options.timeout;
    }
    const safeDuration = Number.isFinite(durationSecs) && durationSecs > 0 ? durationSecs : 0;
    return Math.max(
        WHISPER_TIMEOUT_FLOOR_SECS,
        Math.ceil(safeDuration * WHISPER_TIMEOUT_PER_AUDIO_SEC),
    );
};

/**
 * Shared transcription body — private, NOT exported.
 * Accepts Float32Array or number[] at 16kHz mono.
 * options.translate: when true, passes --translate to whisper.cpp for PROC-06.
 * Returns {success, text, segments, device}.
 */
const transcribeInternal = async (audioData, options = {}) => {
    const modelId = options.modelId || 'Xenova/whisper-medium';
    const useParakeet = isParakeetModel(modelId);
    const binaryPath = useParakeet ? findParakeetBinary() : findBinary();
    const modelPath = findModel(modelId);

    if (!binaryPath || !modelPath) {
        throw new Error(useParakeet
            ? 'Parakeet engine not installed — set up the speech backend again in Settings to update whisper.cpp'
            : 'whisper.cpp binary or model not found');
    }

    if (useParakeet && options.translate === true) {
        throw new Error('Parakeet does not support translate mode');
    }

    // Convert to Float32Array if needed
    let floatArray;
    if (audioData instanceof Float32Array) {
        floatArray = audioData;
    } else if (Array.isArray(audioData)) {
        floatArray = new Float32Array(audioData);
    } else {
        floatArray = new Float32Array(Object.values(audioData));
    }

    // Log audio stats
    const durationSecsNum = floatArray.length / 16000;
    const durationSecs = durationSecsNum.toFixed(1);
    let maxAbs = 0;
    for (let i = 0; i < floatArray.length; i++) {
        const v = Math.abs(floatArray[i]);
        if (v > maxAbs) maxAbs = v;
    }
    console.log(`[whisper.cpp] Audio: ${floatArray.length} samples (${durationSecs}s), peak=${maxAbs.toFixed(4)}`);

    // Write WAV to temp (pid + counter make the name collision-proof)
    const wavPath = path.join(app.getPath('temp'), `whisper-${process.pid}-${++_tempFileCounter}-${Date.now()}.wav`);
    const wavBuffer = float32ToWav(floatArray);
    fs.writeFileSync(wavPath, wavBuffer);

    // Scale the kill-timer to the audio length so long files keep the fast path.
    const timeoutSecs = computeWhisperTimeout(durationSecsNum, options);
    console.log(`[whisper.cpp] timeout budget: ${timeoutSecs}s for ${durationSecs}s of audio`);

    if (useParakeet) {
        try {
            const { text, pid } = await runParakeetCli(wavPath, modelPath, binaryPath, { ...options, timeout: timeoutSecs });
            console.log(`[parakeet] Transcription length: ${text.length}`);
            return {
                success: true,
                text,
                // parakeet-cli emits no machine-readable timestamps — callers
                // in Quilly only consume `text` (segments feed nothing today).
                segments: [],
                device: 'parakeet-cpp',
                pid,
            };
        } finally {
            try { fs.unlinkSync(wavPath); } catch (_) {}
        }
    }

    try {
        const { result, pid } = await runWhisperCpp(wavPath, modelPath, binaryPath, { ...options, timeout: timeoutSecs });

        // Extract text from whisper.cpp JSON output
        const transcription = result.transcription || [];
        const fullText = transcription.map(seg => seg.text).join('').trim();

        // Normalize segments to match Transformers.js format
        const segments = transcription.map(seg => ({
            text: seg.text,
            timestamp: [
                seg.offsets?.from ? seg.offsets.from / 1000 : 0,
                seg.offsets?.to ? seg.offsets.to / 1000 : 0,
            ],
        }));

        console.log(`[whisper.cpp] Transcription length: ${fullText.length}`);

        const backend = getInstalledBackend() || 'cpp';
        return {
            success: true,
            text: fullText,
            segments,
            device: `${backend}-cpp`,
            pid,
        };
    } finally {
        // Clean up temp files
        try { fs.unlinkSync(wavPath); } catch (_) {}
        try { fs.unlinkSync(wavPath + '.json'); } catch (_) {}
    }
};

/**
 * Transcribe audio in the detected/specified language — matches whisperService interface.
 * Accepts Float32Array or number[] at 16kHz mono.
 * Returns {success, text, segments, device}.
 */
const transcribe = async (audioData, options = {}) => {
    return transcribeInternal(audioData, { ...options, translate: false });
};

/**
 * Translate audio to English using Whisper's built-in --translate mode.
 * Used for PROC-06: "translate to English" from speech (no LLM needed).
 * Returns {success, text, segments, device} — same shape as transcribe().
 */
const translateToEnglish = async (audioData, options = {}) => {
    return transcribeInternal(audioData, { ...options, translate: true });
};

module.exports = {
    isAvailable,
    getStatus,
    transcribe,
    translateToEnglish,
    findBinary,
    findParakeetBinary,
    isParakeetModel,
    findModel,
    getBasePath,
    getModelsPath,
    MODEL_ID_TO_GGML,
    setWhisperPrompt,
    computeWhisperTimeout,
    float32ToWav,
};
