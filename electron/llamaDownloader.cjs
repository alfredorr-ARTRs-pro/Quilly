// Downloads llama-server binary from pinned GitHub release and GGUF model files.
// Mirrors whisperCppDownloader.cjs with upgraded download core:
//   - HTTP Range resume from .partial files
//   - Enhanced progress: {percent, speed, eta, bytesDownloaded, totalBytes}
//   - Cancellation via cancelToken.cancel()
//   - Model download with disk space check, validation, retry, and manifest
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, dialog } = require('electron');
const EventEmitter = require('events');

// ─── Module-level EventEmitter ─────────────────────────────────────────────────

const emitter = new EventEmitter();

// ─── Constants ────────────────────────────────────────────────────────────────

const PINNED_TAG = 'b8198';
// Pinned to specific tag — MDL-10 requires reproducible binary, never use the latest-release endpoint
const GITHUB_API_PINNED = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/b8198';

// Known asset names for b8198 (confirmed via GitHub API 2026-03-05)
// Literal strings — changing these requires a new PINNED_TAG
const CUDA_MAIN_ASSET   = 'llama-b8198-bin-win-cuda-12.4-x64.zip';
const CUDA_RT_ASSET     = 'cudart-llama-bin-win-cuda-12.4-x64.zip';
const CPU_ASSET         = 'llama-b8198-bin-win-cpu-x64.zip';

const LLAMA_BINARY_NAME = 'llama-server.exe';

const EXPECTED_LLAMA_ASSETS = {
    [CUDA_MAIN_ASSET]: {
        size: 220_432_377,
        sha256: 'efaa4e1f9c81172dd8b21a424917c3d12ba6925ce6f86d9be8ab897dd52e8635',
    },
    [CUDA_RT_ASSET]: {
        size: 391_443_627,
        sha256: '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6',
    },
    [CPU_ASSET]: {
        size: 31_439_203,
        sha256: '4e3fb9f8814dbb2923ed7c4c1c98a9cdcd865f9d75fa086915bef476119db5ec',
    },
};

// ─── Model Registry ───────────────────────────────────────────────────────────

/**
 * Available GGUF models — Qwen 3.5 from unsloth's quantized GGUF repos on HuggingFace.
 * Both models handle all intents; model selection is based on user preference.
 * sizeApprox is used for disk space pre-check; actual validation uses HTTP content-length.
 */
const MODELS = {
    'qwen3.5-4b': {
        repo: 'unsloth/Qwen3.5-4B-GGUF',
        revision: 'e87f176479d0855a907a41277aca2f8ee7a09523',
        filename: 'Qwen3.5-4B-Q4_K_M.gguf',
        sizeApprox: 2_740_937_888,  // ~2.55 GiB
        sha256: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4',
        url: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf',
    },
    'qwen3.5-9b': {
        repo: 'unsloth/Qwen3.5-9B-GGUF',
        revision: '3885219b6810b007914f3a7950a8d1b469d598a5',
        filename: 'Qwen3.5-9B-Q4_K_M.gguf',
        sizeApprox: 5_680_522_464,  // ~5.29 GiB
        sha256: '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8',
        url: 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/3885219b6810b007914f3a7950a8d1b469d598a5/Qwen3.5-9B-Q4_K_M.gguf',
    },
};

// ─── Path Helpers ─────────────────────────────────────────────────────────────

/**
 * Returns the base storage directory for llama-server and models.
 * Separate from whisper-cpp: %APPDATA%/quilly/llama/
 */
const getBasePath = () => {
    return path.join(app.getPath('userData'), 'llama');
};

/**
 * Returns the models subdirectory under the llama base path.
 */
const getModelsPath = () => {
    return path.join(getBasePath(), 'models');
};

// ─── HTTP Core ────────────────────────────────────────────────────────────────

/**
 * HTTP(S) GET that follows redirects (301, 302, 307, 308).
 * Uses https.request (not https.get) to allow caller-controlled cancellation.
 * Accepts custom headers (merged with default User-Agent).
 * Accepts 200, 206, and 416 as success status codes.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {object} [options.headers] - additional headers (e.g., Range)
 * @returns {Promise<http.IncomingMessage>}
 */
const httpGet = (url, options = {}) => {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const mergedHeaders = {
            'User-Agent': 'Quilly/1.0',
            ...(options.headers || {}),
        };

        const urlObj = new URL(url);
        const reqOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || (url.startsWith('https') ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: mergedHeaders,
        };

        const req = client.request(reqOptions, (res) => {
            // Follow redirects (301, 302, 307, 308)
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                resolve(httpGet(res.headers.location, options));
                return;
            }
            // Accept 200 (full content), 206 (partial content/range honored), and 416
            // (range not satisfiable — .partial already complete; downloadFile handles rename)
            if (res.statusCode !== 200 && res.statusCode !== 206 && res.statusCode !== 416) {
                reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                return;
            }
            resolve(res);
        });

        req.on('error', reject);
        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error(`Timeout fetching ${url}`));
        });
        req.end();
    });
};

// ─── Download Core ────────────────────────────────────────────────────────────

/**
 * Download a file to disk with resume support, enhanced progress, SHA256 hashing, and cancellation.
 *
 * Resume: if destPath + '.partial' exists, its size is used as resumeFrom and a
 * Range: bytes=N- header is sent. On 206, the partial file is appended to. On 200
 * with resumeFrom > 0, the server does not support ranges and download restarts. On
 * 416, the partial file is already complete and is renamed to destPath.
 *
 * Progress: emits {percent, speed, eta, bytesDownloaded, totalBytes} on each chunk.
 * speed is bytes/sec; eta is seconds remaining (null if unknown).
 *
 * SHA256: computed streaming during download via crypto.createHash — no extra disk read.
 *
 * Cancellation: cancelToken = { cancel: null }. After the request starts, cancelToken.cancel
 * is set to a function that destroys the request and rejects with Error('Download cancelled').
 * The .partial file is kept on cancel for future resume.
 *
 * @param {string} url
 * @param {string} destPath
 * @param {function} [onProgress] - ({percent, speed, eta, bytesDownloaded, totalBytes}) => void
 * @param {{ cancel: function|null }} [cancelToken]
 * @returns {Promise<{ path: string, sha256: string, totalSize: number }>}
 */
const downloadFile = async (url, destPath, onProgress, cancelToken) => {
    const partialPath = destPath + '.partial';

    // ── Determine resume offset ──────────────────────────────────────────────
    let resumeFrom = 0;
    if (fs.existsSync(partialPath)) {
        resumeFrom = fs.statSync(partialPath).size;
    }

    const headers = {};
    if (resumeFrom > 0) {
        headers['Range'] = `bytes=${resumeFrom}-`;
    }

    const res = await httpGet(url, { headers });

    // ── Handle 416: range out of bounds — file is already complete ───────────
    if (res.statusCode === 416) {
        if (fs.existsSync(partialPath)) {
            fs.renameSync(partialPath, destPath);
        }
        const actualSize = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
        return { path: destPath, sha256: null, totalSize: actualSize };
    }

    // ── Determine actual start position and total size ───────────────────────
    let startFrom = resumeFrom;
    if (res.statusCode === 200 && resumeFrom > 0) {
        // Server ignored Range header — restart from beginning
        startFrom = 0;
    }

    const contentLength = parseInt(res.headers['content-length'], 10) || 0;
    // For 206, content-length is remaining bytes; total = startFrom + contentLength
    const totalBytes = startFrom + contentLength;

    // ── Open file stream (append for resume, write for fresh start) ──────────
    const fileFlags = (res.statusCode === 206 && startFrom > 0) ? 'a' : 'w';
    const fileStream = fs.createWriteStream(partialPath, { flags: fileFlags });

    // ── Set up SHA256 streaming hash ─────────────────────────────────────────
    const hash = crypto.createHash('sha256');

    // ── Track progress timing ────────────────────────────────────────────────
    const startTime = Date.now();
    let bytesDownloaded = startFrom;

    return new Promise((resolve, reject) => {
        // ── Set up cancellation ──────────────────────────────────────────────
        if (cancelToken) {
            cancelToken.cancel = () => {
                res.destroy();
                fileStream.destroy();
                // Keep .partial file for future resume — do NOT delete
                reject(new Error('Download cancelled'));
            };
        }

        res.on('data', (chunk) => {
            bytesDownloaded += chunk.length;
            fileStream.write(chunk);
            hash.update(chunk);  // SHA256 update on each chunk — no extra disk read

            if (onProgress && totalBytes > 0) {
                const elapsedSec = (Date.now() - startTime) / 1000;
                const bytesSinceStart = bytesDownloaded - startFrom;
                const speed = elapsedSec > 0 ? bytesSinceStart / elapsedSec : 0;
                const remaining = totalBytes - bytesDownloaded;
                const eta = speed > 0 ? Math.round(remaining / speed) : null;

                onProgress({
                    percent: Math.round((bytesDownloaded / totalBytes) * 100),
                    speed,          // bytes/sec; UI formats as MB/s
                    eta,            // seconds remaining; UI formats as "~2 min left"
                    bytesDownloaded,
                    totalBytes,
                });
            }
        });

        res.on('end', () => {
            fileStream.end(() => {
                // Compute final SHA256 digest
                const sha256 = hash.digest('hex');
                // Rename .partial to final path on success
                try {
                    fs.renameSync(partialPath, destPath);
                    resolve({ path: destPath, sha256, totalSize: totalBytes });
                } catch (err) {
                    reject(err);
                }
            });
        });

        res.on('error', (err) => {
            fileStream.destroy();
            // Keep .partial file for resume — do NOT delete (differs from whisperCppDownloader)
            reject(err);
        });
    });
};

// ─── Disk Space Check ─────────────────────────────────────────────────────────

/**
 * Check available disk space before download.
 * Requires 10% buffer above requiredBytes.
 * Throws a user-friendly error if insufficient space.
 *
 * @param {number} requiredBytes - approximate download size in bytes
 * @param {string} downloadPath - directory to check disk space for
 * @throws {Error} with user-friendly message showing GB needed vs available
 */
const ensureDiskSpace = async (requiredBytes, downloadPath) => {
    const checkDiskSpace = require('check-disk-space').default;
    const diskSpace = await checkDiskSpace(downloadPath);

    const requiredWithBuffer = requiredBytes * 1.1;

    if (diskSpace.free < requiredWithBuffer) {
        const neededGB = (requiredWithBuffer / (1024 ** 3)).toFixed(1);
        const availableGB = (diskSpace.free / (1024 ** 3)).toFixed(1);
        throw new Error(
            `Not enough disk space (need ${neededGB} GB, only ${availableGB} GB free). ` +
            `Free up space and try again.`
        );
    }
};

// ─── Download Validation ──────────────────────────────────────────────────────

/**
 * Normalize a GitHub-style digest value to a bare SHA256 hex string.
 *
 * @param {string|null|undefined} digest
 * @returns {string|null}
 */
const normalizeSha256 = (digest) => {
    if (!digest) return null;
    const normalized = String(digest).trim().toLowerCase().replace(/^sha256:/, '');
    return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
};

/**
 * Hash a file from disk without loading it all into memory.
 *
 * @param {string} filePath
 * @param {'sha1'|'sha256'} [algorithm]
 * @returns {Promise<string>}
 */
const hashFile = (filePath, algorithm = 'sha256') => {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash(algorithm);
        const stream = fs.createReadStream(filePath);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
};

/**
 * Validate a completed download by comparing its size and optional SHA256.
 * On mismatch, deletes the corrupt file and throws an error.
 *
 * @param {string} destPath - path to the downloaded file
 * @param {number} expectedSize - expected file size in bytes
 * @param {string} [expectedSha256] - expected SHA256 hex digest
 * @returns {Promise<{ success: boolean, size: number, sha256: string }>}
 * @throws {Error} if file missing or validation fails (corrupt file deleted)
 */
const validateDownload = async (destPath, expectedSize, expectedSha256 = null) => {
    if (!fs.existsSync(destPath)) {
        throw new Error(`Downloaded file not found: ${destPath}`);
    }

    const actualSize = fs.statSync(destPath).size;

    if (actualSize !== expectedSize) {
        fs.unlinkSync(destPath);
        throw new Error(
            `Download corrupt (expected ${expectedSize} bytes, got ${actualSize}). ` +
            `File deleted. Please retry the download.`
        );
    }

    const sha256 = await hashFile(destPath, 'sha256');
    const normalizedExpectedSha256 = normalizeSha256(expectedSha256);
    if (normalizedExpectedSha256 && sha256 !== normalizedExpectedSha256) {
        fs.unlinkSync(destPath);
        throw new Error(
            `Download checksum mismatch for ${path.basename(destPath)}. ` +
            `File deleted. Please retry the download.`
        );
    }

    return { success: true, size: actualSize, sha256 };
};

/**
 * Extract a zip only after checking every entry remains under destDir.
 *
 * @param {string} zipPath
 * @param {string} destDir
 * @param {{ requiredAnyBasenames?: string[] }} [options]
 */
const safeExtractZip = (zipPath, destDir, options = {}) => {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(zipPath);
    const root = path.resolve(destDir);
    const basenames = new Set();

    for (const entry of zip.getEntries()) {
        const entryName = entry.entryName.replace(/\\/g, '/');
        const parts = entryName.split('/').filter(Boolean);
        if (!entryName || entryName.includes('\0') || path.isAbsolute(entryName) || parts.includes('..')) {
            throw new Error(`Unsafe zip entry path: ${entry.entryName}`);
        }

        const targetPath = path.resolve(root, ...parts);
        const relative = path.relative(root, targetPath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error(`Unsafe zip entry path: ${entry.entryName}`);
        }

        if (!entry.isDirectory) {
            basenames.add(path.basename(entryName).toLowerCase());
        }
    }

    const requiredAnyBasenames = options.requiredAnyBasenames || [];
    if (
        requiredAnyBasenames.length > 0 &&
        !requiredAnyBasenames.some(name => basenames.has(name.toLowerCase()))
    ) {
        throw new Error(`Zip ${path.basename(zipPath)} does not contain an expected binary.`);
    }

    zip.extractAllTo(destDir, true);
};

// ─── Retry Logic ──────────────────────────────────────────────────────────────

/**
 * Retry delays for exponential backoff (locked decision: 2s, 5s, 15s).
 */
const RETRY_DELAYS = [2000, 5000, 15000];

/**
 * Wrap downloadFile in a retry loop with exponential backoff.
 *
 * @param {string} url
 * @param {string} destPath
 * @param {function} [onProgress]
 * @param {{ cancel: function|null }} [cancelToken]
 * @param {number} [maxRetries=3]
 * @returns {Promise<{ path: string, sha256: string, totalSize: number }>}
 */
const downloadWithRetry = async (url, destPath, onProgress, cancelToken, maxRetries = 3) => {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await downloadFile(url, destPath, onProgress, cancelToken);
        } catch (err) {
            // Do not retry on explicit cancel
            if (err.message === 'Download cancelled') {
                throw err;
            }

            lastError = err;

            if (attempt < maxRetries) {
                const delay = RETRY_DELAYS[attempt - 1];
                console.log(`[llamaDownloader] Retry ${attempt}/${maxRetries} after ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    throw lastError;
};

// ─── Manifest ─────────────────────────────────────────────────────────────────

/**
 * Write/update the download manifest atomically.
 * Reads existing manifest, merges new entry, writes via temp file + rename.
 *
 * For binary: updates `llamaServer` key.
 * For model: updates `models[modelId]` key.
 *
 * @param {string} type - 'binary' | 'model'
 * @param {string} id - modelId for models, unused for binary
 * @param {object} data - metadata to write
 */
const updateManifest = (type, id, data) => {
    const manifestPath = path.join(getBasePath(), 'manifest.json');
    const tmpPath = path.join(getBasePath(), '.manifest.json.tmp');

    // Read existing manifest (merge, don't overwrite)
    let manifest = {};
    try {
        if (fs.existsSync(manifestPath)) {
            manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        }
    } catch (_) {
        // If manifest is corrupt, start fresh
        manifest = {};
    }

    if (type === 'binary') {
        manifest.llamaServer = data;
    } else if (type === 'model') {
        if (!manifest.models) manifest.models = {};
        manifest.models[id] = data;
    }

    // Atomic write: tmp file then rename
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), 'utf8');
    fs.renameSync(tmpPath, manifestPath);
};

// ─── Partial Download Detection ───────────────────────────────────────────────

/**
 * Scan the models directory for resumable partial downloads.
 * Only returns partials larger than 1 MB (minimum resume threshold — Pitfall 4).
 *
 * Not called at startup in Phase 1 — Phase 5 IPC wiring will call it.
 *
 * @returns {Array<{ modelId: string, filename: string, partialSize: number, partialPath: string }>}
 */
const checkPartialDownloads = () => {
    const modelsPath = getModelsPath();
    const MIN_RESUME_SIZE = 1024 * 1024; // 1 MB

    if (!fs.existsSync(modelsPath)) {
        return [];
    }

    const partials = [];

    try {
        const files = fs.readdirSync(modelsPath);

        for (const file of files) {
            if (!file.endsWith('.partial')) continue;

            const partialPath = path.join(modelsPath, file);
            const partialSize = fs.statSync(partialPath).size;

            if (partialSize < MIN_RESUME_SIZE) continue;

            // Extract base filename (remove .partial suffix)
            const baseFilename = file.slice(0, -'.partial'.length);

            // Find the modelId by matching filename in MODELS registry
            const modelId = Object.keys(MODELS).find(
                id => MODELS[id].filename === baseFilename
            ) || null;

            partials.push({
                modelId,
                filename: baseFilename,
                partialSize,
                partialPath,
            });
        }
    } catch (_) {
        return [];
    }

    return partials;
};

// ─── Model Download ───────────────────────────────────────────────────────────

/**
 * Download a GGUF model from HuggingFace (bartowski quantized repos).
 *
 * Steps:
 *   1. Validate modelId is in MODELS registry
 *   2. Skip if already downloaded and size matches (within 5% tolerance)
 *   3. Check disk space (with 10% buffer)
 *   4. Download with 3 automatic retries (2s/5s/15s backoff)
 *   5. Validate downloaded file against HTTP content-length
 *   6. Write manifest with metadata (sha256, size, downloadDate, repo)
 *
 * On retry exhaustion, shows Electron dialog with Retry/Cancel buttons.
 * Emits 'progress', 'complete', 'error' events on module emitter.
 *
 * @param {string} modelId - key in MODELS ('qwen3.5-4b' | 'qwen3.5-9b')
 * @param {function} [onProgress] - ({percent, speed, eta, bytesDownloaded, totalBytes}) => void
 * @param {{ cancel: function|null }} [cancelToken]
 * @returns {Promise<{ success: boolean, modelPath: string }>}
 */
const downloadModel = async (modelId, onProgress, cancelToken) => {
    const model = MODELS[modelId];
    if (!model) {
        throw new Error(`Unknown model ID: "${modelId}". Available: ${Object.keys(MODELS).join(', ')}`);
    }

    const modelsPath = getModelsPath();
    fs.mkdirSync(modelsPath, { recursive: true });

    const destPath = path.join(modelsPath, model.filename);

    // Skip if already downloaded (size within 5% tolerance — exact size from content-length)
    if (fs.existsSync(destPath)) {
        const existingSize = fs.statSync(destPath).size;
        if (existingSize === model.sizeApprox && (!model.sha256 || await hashFile(destPath, 'sha256') === model.sha256)) {
            console.log(`[llamaDownloader] Model already exists: ${destPath}`);
            return { success: true, modelPath: destPath };
        }
        fs.unlinkSync(destPath);
    }

    // Check disk space before starting download
    await ensureDiskSpace(model.sizeApprox, modelsPath);

    // Track content-length total for validation after download
    let trackedTotalSize = 0;

    const progressCallback = (progress) => {
        if (progress.totalBytes > 0) {
            trackedTotalSize = progress.totalBytes;
        }
        if (onProgress) onProgress(progress);
        emitter.emit('progress', { type: 'model', modelId, ...progress });
    };

    let downloadResult;
    try {
        downloadResult = await downloadWithRetry(model.url, destPath, progressCallback, cancelToken);
        trackedTotalSize = downloadResult.totalSize;
    } catch (err) {
        emitter.emit('error', { type: 'model', modelId, error: err });

        // Show error dialog with Retry/Cancel after all retries exhausted
        // (Do not show dialog for explicit cancellations)
        if (err.message !== 'Download cancelled') {
            try {
                const response = await dialog.showMessageBox({
                    type: 'error',
                    title: 'Download Failed',
                    message: `Failed to download ${model.filename}`,
                    detail: err.message,
                    buttons: ['Retry', 'Cancel'],
                    defaultId: 0,
                    cancelId: 1,
                });

                if (response.response === 0) {
                    // Retry — one more attempt (recursive)
                    return downloadModel(modelId, onProgress, cancelToken);
                }
            } catch (_dialogErr) {
                // Dialog unavailable (e.g., during tests) — just rethrow
            }
        }

        throw err;
    }

    // Validate downloaded file against HTTP content-length
    let validation = { sha256: downloadResult.sha256, size: downloadResult.totalSize };
    if (trackedTotalSize > 0) {
        validation = await validateDownload(destPath, trackedTotalSize, model.sha256);
    }

    // Write manifest with full metadata
    updateManifest('model', modelId, {
        filename: model.filename,
        size: validation.size,
        sha256: validation.sha256,
        downloadDate: new Date().toISOString(),
        repo: model.repo,
        revision: model.revision,
    });

    emitter.emit('complete', { type: 'model', modelId, path: destPath });
    console.log(`[llamaDownloader] Model installed at: ${destPath}`);

    return { success: true, modelPath: destPath };
};

// ─── Binary Discovery ─────────────────────────────────────────────────────────

/**
 * Search the base path and known subdirectories for llama-server.exe.
 * @returns {string|null} full path to llama-server.exe or null if not found
 */
const findBinary = () => {
    const base = getBasePath();
    const subdirs = ['', 'bin', 'build/bin'];

    for (const subdir of subdirs) {
        const candidate = subdir
            ? path.join(base, subdir, LLAMA_BINARY_NAME)
            : path.join(base, LLAMA_BINARY_NAME);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
};

// ─── Binary Download ──────────────────────────────────────────────────────────

/**
 * Download and extract llama-server from the pinned b8198 release.
 *
 * CUDA path (useCuda === true): downloads two ZIPs — main binary zip + cudart runtime zip.
 * Both are extracted to the same directory so DLLs are co-located with llama-server.exe.
 *
 * CPU path (useCuda === false): downloads a single ZIP.
 *
 * Progress stages emitted to onProgress:
 *   'downloading-binary'  — downloading the main binary zip
 *   'downloading-cudart'  — downloading cudart zip (CUDA only)
 *   'extracting'          — extracting zip(s)
 *   'done'                — binary verified and ready
 *
 * Also checks disk space before download:
 *   ~250 MB for CUDA variant, ~50 MB for CPU.
 *
 * @param {function} [onProgress] - (event) => void; event has { stage, ...progressFields }
 * @param {boolean} [useCuda=true] - download CUDA 12.4 build; false = CPU build
 * @param {{ cancel: function|null }} [cancelToken] - set cancelToken.cancel to abort
 * @returns {Promise<{ success: boolean, binaryPath: string, tag: string, variant: string }>}
 */
const downloadBinary = async (onProgress, useCuda = true, cancelToken) => {
    const basePath = getBasePath();
    fs.mkdirSync(basePath, { recursive: true });

    // Check if correct version is already installed via manifest
    const manifestPath = path.join(basePath, 'manifest.json');
    if (fs.existsSync(manifestPath) && findBinary()) {
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            if (manifest.llamaServer?.version === PINNED_TAG) {
                console.log(`[llamaDownloader] Binary already installed at correct version (${PINNED_TAG}), skipping download`);
                return { success: true, binaryPath: findBinary(), tag: PINNED_TAG, variant: useCuda ? 'cuda-12.4' : 'cpu' };
            }
            // Version mismatch — delete old binary and re-download
            console.log(`[llamaDownloader] Binary version mismatch: installed=${manifest.llamaServer?.version}, required=${PINNED_TAG}. Re-downloading...`);
        } catch (_) { /* corrupt manifest, proceed with download */ }
    }

    // Check disk space before download
    const binarySizeEstimate = useCuda ? 250 * 1024 * 1024 : 50 * 1024 * 1024;
    await ensureDiskSpace(binarySizeEstimate, basePath);

    // ── Step 1: Fetch pinned release metadata ────────────────────────────────
    console.log(`[llamaDownloader] Fetching release metadata for tag ${PINNED_TAG}...`);
    const metaRes = await httpGet(GITHUB_API_PINNED);

    const release = await new Promise((resolve, reject) => {
        let data = '';
        metaRes.on('data', chunk => (data += chunk));
        metaRes.on('end', () => {
            try {
                resolve(JSON.parse(data));
            } catch (e) {
                reject(new Error(`Failed to parse GitHub release metadata: ${e.message}`));
            }
        });
        metaRes.on('error', reject);
    });

    console.log(`[llamaDownloader] Release: ${release.tag_name} (${release.assets.length} assets)`);

    // Helper: find asset by exact name and confirm it matches the pinned metadata.
    const findAsset = (assetName) => {
        const asset = release.assets.find(a => a.name === assetName);
        if (!asset) {
            throw new Error(`Asset "${assetName}" not found in release ${PINNED_TAG}. Available: ${release.assets.map(a => a.name).join(', ')}`);
        }

        const expected = EXPECTED_LLAMA_ASSETS[assetName];
        if (!expected) {
            throw new Error(`No pinned checksum metadata for ${assetName}`);
        }
        if (asset.size !== expected.size) {
            throw new Error(`Unexpected size for ${assetName}: expected ${expected.size}, got ${asset.size}`);
        }

        const apiSha256 = normalizeSha256(asset.digest);
        if (apiSha256 && apiSha256 !== expected.sha256) {
            throw new Error(`Unexpected GitHub digest for ${assetName}`);
        }

        return {
            url: asset.browser_download_url,
            name: asset.name,
            size: expected.size,
            sha256: expected.sha256,
        };
    };

    const cudaVariant = useCuda ? 'cuda-12.4' : 'cpu';
    const installedAssets = {};

    const progressWrap = (stage, p) => {
        const progressData = { stage, ...p };
        if (onProgress) onProgress(progressData);
        emitter.emit('progress', { type: 'binary', ...progressData });
    };

    if (useCuda) {
        // ── Step 2a: CUDA path — download main binary zip ────────────────────
        console.log(`[llamaDownloader] CUDA path: downloading ${CUDA_MAIN_ASSET}...`);
        const mainAsset = findAsset(CUDA_MAIN_ASSET);
        const mainZipPath = path.join(basePath, CUDA_MAIN_ASSET);

        progressWrap('downloading-binary', { percent: 0 });
        await downloadFile(mainAsset.url, mainZipPath, (p) => {
            progressWrap('downloading-binary', p);
        }, cancelToken);
        installedAssets[mainAsset.name] = await validateDownload(mainZipPath, mainAsset.size, mainAsset.sha256);

        // ── Step 2b: CUDA path — download cudart runtime zip ─────────────────
        console.log(`[llamaDownloader] CUDA path: downloading ${CUDA_RT_ASSET}...`);
        const cudartAsset = findAsset(CUDA_RT_ASSET);
        const cudartZipPath = path.join(basePath, CUDA_RT_ASSET);

        progressWrap('downloading-cudart', { percent: 0 });
        await downloadFile(cudartAsset.url, cudartZipPath, (p) => {
            progressWrap('downloading-cudart', p);
        }, cancelToken);
        installedAssets[cudartAsset.name] = await validateDownload(cudartZipPath, cudartAsset.size, cudartAsset.sha256);

        // ── Step 2c: Extract both ZIPs to the same directory ─────────────────
        progressWrap('extracting', { percent: 0 });
        console.log('[llamaDownloader] Extracting CUDA binary zip...');
        safeExtractZip(mainZipPath, basePath, { requiredAnyBasenames: [LLAMA_BINARY_NAME] });
        try { fs.unlinkSync(mainZipPath); } catch (_) {}

        console.log('[llamaDownloader] Extracting cudart zip...');
        safeExtractZip(cudartZipPath, basePath);
        try { fs.unlinkSync(cudartZipPath); } catch (_) {}

    } else {
        // ── Step 3: CPU path — download single zip ───────────────────────────
        console.log(`[llamaDownloader] CPU path: downloading ${CPU_ASSET}...`);
        const cpuAsset = findAsset(CPU_ASSET);
        const cpuZipPath = path.join(basePath, CPU_ASSET);

        progressWrap('downloading-binary', { percent: 0 });
        await downloadFile(cpuAsset.url, cpuZipPath, (p) => {
            progressWrap('downloading-binary', p);
        }, cancelToken);
        installedAssets[cpuAsset.name] = await validateDownload(cpuZipPath, cpuAsset.size, cpuAsset.sha256);

        // Extract
        progressWrap('extracting', { percent: 0 });
        console.log('[llamaDownloader] Extracting CPU binary zip...');
        safeExtractZip(cpuZipPath, basePath, { requiredAnyBasenames: [LLAMA_BINARY_NAME] });
        try { fs.unlinkSync(cpuZipPath); } catch (_) {}
    }

    // ── Step 4: Verify extraction ────────────────────────────────────────────
    const binaryPath = findBinary();
    if (!binaryPath) {
        throw new Error(
            `Extraction succeeded but ${LLAMA_BINARY_NAME} not found in ${basePath}. ` +
            `Check the zip contents and extraction path.`
        );
    }

    // ── Step 5: Write binary manifest entry ──────────────────────────────────
    updateManifest('binary', null, {
        version: PINNED_TAG,
        installedAt: new Date().toISOString(),
        cudaVariant,
        binaryPath,
        assets: installedAssets,
    });

    // ── Step 6: Return result ────────────────────────────────────────────────
    progressWrap('done', { percent: 100 });
    emitter.emit('complete', { type: 'binary', path: binaryPath });
    console.log(`[llamaDownloader] Binary installed at: ${binaryPath} (variant: ${cudaVariant}, tag: ${PINNED_TAG})`);

    return {
        success: true,
        binaryPath,
        tag: PINNED_TAG,
        variant: cudaVariant,
    };
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    downloadBinary,
    downloadModel,
    downloadFile,
    httpGet,
    getBasePath,
    getModelsPath,
    findBinary,
    checkPartialDownloads,
    validateDownload,
    ensureDiskSpace,
    events: emitter,  // EventEmitter for Phase 8 UI subscription
    MODELS,           // Expose for Phase 5/8 to list available models
    // Constants exposed for callers
    PINNED_TAG,
};
