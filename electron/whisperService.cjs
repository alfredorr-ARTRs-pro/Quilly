// Whisper transcription service — unified dispatcher
// Priority: whisper.cpp (native CUDA on Windows) → Transformers.js (CUDA on Linux, CPU fallback)
const path = require('path');
const { app } = require('electron');
const whisperCpp = require('./whisperCppService.cjs');

let pipeline;
let env;

// Default model
const DEFAULT_MODEL = 'Xenova/whisper-medium';

// Pass-through model ID (allow Xenova models on v3)
const normalizeModelId = (modelId) => modelId;

// Lazy load transformers
const loadTransformers = async () => {
    if (!pipeline) {
        const transformers = await import('@huggingface/transformers');
        pipeline = transformers.pipeline;
        env = transformers.env;

        // Configure cache directory
        env.cacheDir = path.join(app.getPath('userData'), 'transformers-cache');
        console.log('Transformers cache dir:', env.cacheDir);

        // Ensure we don't use browser cache
        env.allowLocalModels = false;
        env.useBrowserCache = false;
    }
    return { pipeline, env };
};

let transcriber = null;
let currentModelId = null;
let currentDevice = null;

// Idle auto-dispose: free model from RAM after 2 minutes of inactivity
const IDLE_TIMEOUT_MS = 2 * 60 * 1000;
let idleTimer = null;

const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
        console.log('Idle timeout reached, disposing model to free RAM');
        await dispose();
    }, IDLE_TIMEOUT_MS);
};

const dispose = async () => {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
    if (transcriber) {
        console.log('Disposing transcriber for model:', currentModelId);
        if (typeof transcriber.dispose === 'function') {
            await transcriber.dispose();
        }
        transcriber = null;
        currentModelId = null;
        currentDevice = null;
    }
};

// Singleton lock: prevents two concurrent calls from loading the model twice
let loadingPromise = null;

const getTranscriber = async (modelId = DEFAULT_MODEL) => {
    modelId = normalizeModelId(modelId);

    if (transcriber && currentModelId !== modelId) {
        console.log(`Model changed from ${currentModelId} to ${modelId}, disposing old`);
        await dispose();
    }

    if (transcriber) return transcriber;

    // If a load is already in-flight, piggyback on it
    if (loadingPromise) return loadingPromise;

    loadingPromise = (async () => {
        try {
            const { pipeline } = await loadTransformers();
            console.log(`Loading Whisper model: ${modelId}`);

            // Progress callback
            const progress_callback = (progress) => {
                if (progress.status === 'progress') {
                    // verify we aren't spamming logs
                } else {
                    console.log(`Model status: ${progress.status} - ${progress.file}`);
                }
            };

            // GPU is only viable on Linux x64 (CUDA). DirectML on Windows produces
            // hallucinated output with Whisper due to missing decoder ops.
            const gpuDevice = (process.platform === 'linux' && process.arch === 'x64')
                ? 'cuda' : null;

            if (gpuDevice) {
                try {
                    console.log(`Attempting GPU device '${gpuDevice}' for ${modelId}...`);
                    transcriber = await pipeline('automatic-speech-recognition', modelId, {
                        device: gpuDevice,
                        dtype: 'fp32',
                        progress_callback,
                    });
                    currentDevice = gpuDevice;
                    console.log(`Model ${modelId} loaded successfully with ${gpuDevice.toUpperCase()}`);
                } catch (gpuError) {
                    console.warn(`GPU (${gpuDevice}) init failed, falling back to CPU:`, gpuError.message);
                    transcriber = null;
                }
            }

            // CPU path — reliable on all platforms, q8 quantization for speed
            if (!transcriber) {
                console.log('Initializing CPU backend (q8 quantized)...');
                transcriber = await pipeline('automatic-speech-recognition', modelId, {
                    device: 'cpu',
                    dtype: 'q8',
                    progress_callback,
                });
                currentDevice = 'cpu';
                console.log(`Model ${modelId} loaded successfully with CPU (q8)`);
            }

            currentModelId = modelId;
            return transcriber;
        } finally {
            loadingPromise = null;
        }
    })();

    return loadingPromise;
};

// Track consecutive whisper.cpp failures — disable after 3
let cppFailCount = 0;
const MAX_CPP_FAILURES = 3;
let cppDisabledForSession = false;

const ensureWhisperCppModel = async (modelId, onProgress) => {
    if (!whisperCpp.findBinary || !whisperCpp.findModel) return false;
    if (!whisperCpp.findBinary() || whisperCpp.findModel(modelId)) return false;

    try {
        console.log(`[whisperService] whisper.cpp model missing for ${modelId}; downloading GGML model before transcription...`);
        const whisperCppDownloader = require('./whisperCppDownloader.cjs');
        await whisperCppDownloader.downloadModel(modelId, onProgress);
        return true;
    } catch (err) {
        console.warn(`[whisperService] Failed to prepare whisper.cpp model for ${modelId}: ${err.message}`);
        return false;
    }
};

const transcribe = async (audioData, options = {}) => {
    try {
        const modelId = normalizeModelId(options.modelId || DEFAULT_MODEL);
        console.log(`Starting transcription, model: ${modelId}`);

        if (!cppDisabledForSession && !whisperCpp.isAvailable(modelId)) {
            await ensureWhisperCppModel(modelId, options.onProgress);
        }

        // Try whisper.cpp first (native CUDA on Windows)
        if (!cppDisabledForSession && whisperCpp.isAvailable(modelId)) {
            try {
                console.log('Routing to whisper.cpp (CUDA)...');
                const result = await whisperCpp.transcribe(audioData, { ...options, modelId });
                cppFailCount = 0; // Reset on success
                return result;
            } catch (cppError) {
                cppFailCount++;
                console.warn(`whisper.cpp failed (${cppFailCount}/${MAX_CPP_FAILURES}):`, cppError.message);
                if (cppFailCount >= MAX_CPP_FAILURES) {
                    console.warn('whisper.cpp disabled for this session after repeated failures');
                    cppDisabledForSession = true;
                }
                console.log('Falling back to Transformers.js CPU...');
            }
        }

        // Transformers.js path (CPU on Windows, CUDA on Linux)
        const transcriber = await getTranscriber(modelId);
        console.log(`Transcribing with device: ${currentDevice}`);

        // Convert incoming data to Float32Array
        let floatArray;
        if (audioData instanceof Float32Array) {
            floatArray = audioData;
        } else if (Array.isArray(audioData)) {
            floatArray = new Float32Array(audioData);
        } else {
            floatArray = new Float32Array(Object.values(audioData));
        }

        // Log audio stats for debugging
        const durationSecs = (floatArray.length / 16000).toFixed(1);
        let maxAbs = 0;
        for (let i = 0; i < floatArray.length; i++) {
            const v = Math.abs(floatArray[i]);
            if (v > maxAbs) maxAbs = v;
        }
        console.log(`Audio: ${floatArray.length} samples (${durationSecs}s), peak=${maxAbs.toFixed(4)}`);

        // Run transcription
        const transcribeOptions = {
            chunk_length_s: 30,
            stride_length_s: 5,
            task: 'transcribe',
        };
        if (options.language) {
            transcribeOptions.language = options.language;
        }

        const output = await transcriber(floatArray, transcribeOptions);

        console.log('Transcription output length:', output.text.length);

        // Free the fallback Transformers model immediately after the result is delivered.
        const response = {
            success: true,
            text: output.text || '',
            segments: output.chunks || [],
            device: currentDevice,
        };

        await dispose();
        return response;

    } catch (error) {
        console.error('Transcription error:', error);
        await dispose();
        return { success: false, error: error.message };
    }
};

// Mock/Helper functions
const modelExists = () => true;
const downloadModel = async () => ({ success: true });
const getModelPath = () => path.join(app.getPath('userData'), 'transformers-cache');
const preloadModel = async (modelId) => {
    try {
        await getTranscriber(modelId);
        resetIdleTimer();
        return { success: true, device: currentDevice };
    } catch (e) {
        return { success: false, error: e.message };
    }
};
const getCurrentModel = () => currentModelId;
const getCurrentDevice = () => currentDevice;

module.exports = {
    transcribe,
    modelExists,
    downloadModel,
    getModelPath,
    dispose,
    preloadModel,
    getCurrentModel,
    getCurrentDevice,
};
