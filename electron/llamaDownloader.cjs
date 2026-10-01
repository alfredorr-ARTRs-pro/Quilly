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
const platformUtils = require('./platformUtils.cjs');

// ─── Module-level EventEmitter ─────────────────────────────────────────────────

const emitter = new EventEmitter();

// ─── Constants ────────────────────────────────────────────────────────────────

// b9859 (2026-07-01) — bumped from b8198 (2026-03-04) to support post-March-2026
// model families (Qwen 3.6, Gemma 4). llama-server flags used by llamaService
// (--model/--port/--host/--n-gpu-layers/--ctx-size/--parallel, plus --n-cpu-moe)
// verified current against the b9859-era server docs on 2026-07-02.
const PINNED_TAG = 'b9859';
// Pinned to specific tag — MDL-10 requires reproducible binary, never use the latest-release endpoint
const GITHUB_API_PINNED = `https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${PINNED_TAG}`;

// Known asset names for b9859 (confirmed via GitHub API 2026-07-02)
// Literal strings — changing these requires a new PINNED_TAG
const CUDA_MAIN_ASSET   = 'llama-b9859-bin-win-cuda-12.4-x64.zip';
const CUDA_RT_ASSET     = 'cudart-llama-bin-win-cuda-12.4-x64.zip';
const CPU_ASSET         = 'llama-b9859-bin-win-cpu-x64.zip';
// macOS Apple Silicon build — single tarball with Metal enabled, dylibs
// colocated with the binaries (no CUDA/cudart concept).
const MAC_ASSET         = 'llama-b9859-bin-macos-arm64.tar.gz';

const IS_MAC = process.platform === 'darwin';
const LLAMA_BINARY_NAME = IS_MAC ? 'llama-server' : 'llama-server.exe';

// Sizes + sha256 from the GitHub API digest fields; the CPU zip was also
// downloaded locally on 2026-07-02 and its hash matched. The macOS tarball
// was downloaded and hashed locally on 2026-07-04.
const EXPECTED_LLAMA_ASSETS = {
    [CUDA_MAIN_ASSET]: {
        size: 266_068_914,
        sha256: '05ae4f4f0b141a11c72dd18b58af28356725be99f2bdd1867e3787601b3de9ec',
    },
    [CUDA_RT_ASSET]: {
        size: 391_443_627,
        sha256: '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6',
    },
    [CPU_ASSET]: {
        size: 17_478_474,
        sha256: 'c9aa80f233a7d1749341860f11723b912d4cfd6eec19434c3d00bba0abc9f85c',
    },
    [MAC_ASSET]: {
        size: 11_134_464,
        sha256: '21e720ac103d28d7585a52b8023fb86fc0736c90ad92c1e75053207630e90df6',
    },
};

// ─── Model Registry ───────────────────────────────────────────────────────────

/**
 * Available GGUF models — Qwen 3.5 from unsloth's quantized GGUF repos on HuggingFace.
 * Both models handle all intents; model selection is based on user preference.
 * sizeApprox MUST be the exact byte count of the pinned artifact (copy it from
 * the HF file listing, never estimate): downloads are validated against it with
 * an exact match and deleted on mismatch, and the already-installed skip check
 * compares with ===.
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
    // Max tier — Qwen3.6 MoE (35B total / ~3B active, Apache 2.0). Decodes at
    // roughly 4B-dense speed but needs the full ~21GB of weights in memory:
    // main.cjs gates the download on total system RAM. Requires llama-server
    // ≥ b93xx (Qwen3.6 support) — covered by PINNED_TAG b9859.
    'qwen3.6-35b-a3b': {
        repo: 'unsloth/Qwen3.6-35B-A3B-GGUF',
        revision: 'a483e9e6cbd595906af30beda3187c2663a1118c',
        filename: 'Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf',
        sizeApprox: 22_360_456_160,  // ~20.8 GiB
        sha256: '707a55a8a4397ecde44de0c499d3e68c1ad1d240d1da65826b4949d1043f4450',
        url: 'https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/a483e9e6cbd595906af30beda3187c2663a1118c/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf',
        // Keep the MoE expert weights on CPU: consumer GPUs (6-12GB VRAM)
        // cannot hold 21GB of weights, and with only ~3B active parameters the
        // CPU-resident experts still decode at usable speed while attention
        // runs on the GPU. Harmless in pure-CPU mode.
        extraServerArgs: ['--n-cpu-moe', '999'],
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
            // Follow redirects (301, 302, 307, 308) — bounded, and with the 3xx
            // body drained so keep-alive sockets are not leaked per hop.
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const depth = options._redirectDepth || 0;
                res.resume();
                if (depth >= 5) {
                    reject(new Error(`Too many redirects for ${url}`));
                    return;
                }
                resolve(httpGet(res.headers.location, { ...options, _redirectDepth: depth + 1 }));
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
 * Integrity: NOT verified here — callers validate the finished file against
 * pinned size+sha256 via validateDownload().
 *
 * Cancellation: cancelToken = { cancel: null, cancelled?: boolean }. Setting
 * cancelToken.cancelled (directly or via the cancel() function this installs)
 * aborts at the next phase boundary and rejects with Error('Download cancelled').
 * The .partial file is kept on cancel for future resume.
 *
 * @param {string} url
 * @param {string} destPath
 * @param {function} [onProgress] - ({percent, speed, eta, bytesDownloaded, totalBytes}) => void
 * @param {{ cancel: function|null, cancelled?: boolean }} [cancelToken]
 * @returns {Promise<{ path: string, totalSize: number }>}
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

    // Cancellation uses a PERSISTENT token.cancelled flag (not just the
    // re-wired token.cancel function): a cancel that lands while this download
    // is queued, connecting, or between retry attempts must survive into the
    // next phase/attempt, or the download silently resurrects.
    if (cancelToken) {
        if (cancelToken.cancelled) {
            throw new Error('Download cancelled');
        }
        cancelToken.cancel = () => { cancelToken.cancelled = true; };
    }

    const res = await httpGet(url, { headers });

    if (cancelToken?.cancelled) {
        res.destroy();
        throw new Error('Download cancelled');
    }

    // ── Handle 416: range out of bounds — file is already complete ───────────
    if (res.statusCode === 416) {
        res.resume();
        if (fs.existsSync(partialPath)) {
            fs.renameSync(partialPath, destPath);
        }
        const actualSize = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
        return { path: destPath, totalSize: actualSize };
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

    // No streaming hash here: every caller validates the finished file against
    // pinned size+sha256 via validateDownload (a streaming digest would be
    // wrong on resumed downloads anyway — it only covers appended bytes).

    // ── Track progress timing ────────────────────────────────────────────────
    const startTime = Date.now();
    let bytesDownloaded = startFrom;

    return new Promise((resolve, reject) => {
        // Settle-once guard: cancel, stream error, stall, and finish can race.
        let settled = false;
        let stallTimer = null;
        const fail = (err) => {
            if (settled) return;
            settled = true;
            if (stallTimer) clearTimeout(stallTimer);
            res.destroy();
            fileStream.destroy();
            // Keep .partial file for future resume — do NOT delete
            reject(err);
        };

        // Stall watchdog: a socket that dies silently after headers (observed
        // live 2026-07-02: 0 bytes written, connection never closed) would
        // otherwise hang this promise — and the serialized binary-download
        // chain behind it — forever. No data for 60s → fail → retry loop
        // takes over with a fresh connection (resume supported).
        const armStallTimer = () => {
            if (stallTimer) clearTimeout(stallTimer);
            stallTimer = setTimeout(() => {
                fail(new Error('Download stalled — no data received for 60s'));
            }, 60_000);
        };
        armStallTimer();

        // ── Set up cancellation ──────────────────────────────────────────────
        if (cancelToken) {
            cancelToken.cancel = () => {
                cancelToken.cancelled = true;
                fail(new Error('Download cancelled'));
            };
        }

        res.on('data', (chunk) => {
            armStallTimer();
            bytesDownloaded += chunk.length;

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

        // pipe() writes with backpressure (a raw write() loop lets a fast
        // network balloon memory against a slow disk); the 'data' listener
        // above only observes chunks for progress reporting.
        res.pipe(fileStream);

        // Without this handler a disk-full/AV-lock write error is an
        // unhandled 'error' event → uncaughtException in the main process,
        // and the download promise would never settle.
        fileStream.on('error', (err) => {
            fail(new Error(`Disk write failed: ${err.message}`));
        });

        fileStream.on('finish', () => {
            if (settled) return;
            if (stallTimer) clearTimeout(stallTimer);
            // Rename .partial to final path on success
            try {
                fs.renameSync(partialPath, destPath);
                settled = true;
                resolve({ path: destPath, totalSize: totalBytes });
            } catch (err) {
                settled = true;
                reject(err);
            }
        });

        res.on('error', (err) => {
            // Keep .partial file for resume — do NOT delete (differs from whisperCppDownloader)
            fail(err);
        });

        // A destroyed/aborted socket emits 'close' without 'error' — convert
        // an incomplete body into a failure so the retry loop can take over.
        res.on('close', () => {
            if (!settled && !res.complete) {
                fail(new Error('Connection closed before download completed'));
            }
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
 * Entry validation uses adm-zip's central directory (cheap — no inflation);
 * the actual extraction runs in a child process via
 * platformUtils.extractArchive (Expand-Archive on Windows, ditto on macOS —
 * adm-zip's extractAllTo blocks the Electron main thread and is
 * pathologically slow on huge entries, observed live 2026-07-02).
 *
 * @param {string} zipPath
 * @param {string} destDir
 * @param {{ requiredAnyBasenames?: string[] }} [options]
 * @returns {Promise<void>}
 */
const safeExtractZip = async (zipPath, destDir, options = {}) => {
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

    await platformUtils.extractArchive(zipPath, destDir);
};

/**
 * Extract a .tar.gz archive (macOS llama.cpp assets). tar.gz has no cheap
 * central directory to pre-scan, but bsdtar refuses absolute paths and `..`
 * traversal by default (no -P flag), so extraction itself is the safety
 * boundary; callers verify the expected binary exists afterwards.
 */
const safeExtractTarGz = async (tarPath, destDir) => {
    await platformUtils.extractArchive(tarPath, destDir);
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
        // A cancel can land between attempts (backoff sleep, or while a failing
        // attempt is settling) — the persistent token flag is the only signal
        // that survives, since each attempt re-wires token.cancel.
        if (cancelToken?.cancelled) {
            throw new Error('Download cancelled');
        }
        try {
            return await downloadFile(url, destPath, onProgress, cancelToken);
        } catch (err) {
            // Do not retry on explicit cancel
            if (err.message === 'Download cancelled' || cancelToken?.cancelled) {
                throw new Error('Download cancelled');
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

const readManifest = () => {
    const manifestPath = path.join(getBasePath(), 'manifest.json');
    try {
        if (fs.existsSync(manifestPath)) {
            return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        }
    } catch (_) {
        return {};
    }
    return {};
};

const getBinaryStatus = () => {
    const binaryPath = findBinary();
    const manifest = readManifest();
    const llamaServer = manifest.llamaServer || {};

    return {
        installed: !!binaryPath,
        binaryPath,
        version: llamaServer.version || null,
        variant: llamaServer.cudaVariant || null,
    };
};

const isBinaryCompatibleWithMode = (useCuda) => {
    const status = getBinaryStatus();
    if (!status.installed) return false;
    // The version must match the pin in BOTH modes — checking it only for CUDA
    // meant a PINNED_TAG bump upgraded CUDA installs but left CPU installs on
    // the old build forever.
    if (status.version !== PINNED_TAG) return false;
    // macOS has exactly one build (Metal) — GPU mode is irrelevant.
    if (IS_MAC) return status.variant === 'metal';
    if (!useCuda) return true;

    return status.variant === 'cuda-12.4';
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
 * Download a GGUF model from HuggingFace (unsloth quantized repos).
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

    // Skip if already downloaded (exact pinned size + checksum match)
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

    const progressCallback = (progress) => {
        if (onProgress) onProgress(progress);
        emitter.emit('progress', { type: 'model', modelId, ...progress });
    };

    try {
        await downloadWithRetry(model.url, destPath, progressCallback, cancelToken);
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

    // Validate against the registry's pinned size + sha256 (exact values) rather
    // than the HTTP content-length: some proxies strip content-length, and a
    // resumed download's streaming hash covers only the appended bytes — the
    // pinned values are the only trustworthy reference either way.
    const validation = await validateDownload(destPath, model.sizeApprox, model.sha256);

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
    // The macOS tarball nests everything under a llama-<tag>/ directory.
    const subdirs = ['', 'bin', 'build/bin', `llama-${PINNED_TAG}`];

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
 * Download and extract llama-server from the pinned release (PINNED_TAG).
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
const downloadBinaryInternal = async (onProgress, useCuda = true, cancelToken) => {
    // A cancel may have landed while this run was queued on the serialization
    // chain — honor it before doing any work.
    if (cancelToken?.cancelled) {
        throw new Error('Download cancelled');
    }
    const basePath = getBasePath();
    fs.mkdirSync(basePath, { recursive: true });
    // macOS: single Metal build — CUDA never applies regardless of settings.
    if (IS_MAC) useCuda = false;
    const requestedVariant = IS_MAC ? 'metal' : (useCuda ? 'cuda-12.4' : 'cpu');

    // Check if the correct version AND runtime variant are already installed.
    const manifestPath = path.join(basePath, 'manifest.json');
    if (fs.existsSync(manifestPath) && findBinary()) {
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const installedVariant = manifest.llamaServer?.cudaVariant || null;
            if (
                manifest.llamaServer?.version === PINNED_TAG &&
                installedVariant === requestedVariant
            ) {
                console.log(`[llamaDownloader] Binary already installed at correct version/variant (${PINNED_TAG}, ${requestedVariant}), skipping download`);
                return { success: true, binaryPath: findBinary(), tag: PINNED_TAG, variant: requestedVariant };
            }
            console.log(
                `[llamaDownloader] Binary mismatch: installed=${manifest.llamaServer?.version || 'unknown'}/${installedVariant || 'unknown'}, required=${PINNED_TAG}/${requestedVariant}. Re-downloading...`
            );
        } catch (_) { /* corrupt manifest, proceed with download */ }
    }

    // Check disk space before download. CUDA needs the two zips (220MB + 391MB)
    // plus the extracted payload coexisting transiently — ~1.3GB peak, not 250MB.
    // macOS tarball is ~11MB compressed; 100MB covers archive + payload.
    const binarySizeEstimate = useCuda ? 1300 * 1024 * 1024 : 100 * 1024 * 1024;
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

    const cudaVariant = requestedVariant;
    const installedAssets = {};

    const progressWrap = (stage, p) => {
        const progressData = { stage, ...p };
        if (onProgress) onProgress(progressData);
        emitter.emit('progress', { type: 'binary', ...progressData });
    };

    // Download an asset zip unless a fully-validated copy is already on disk
    // (e.g. a previous attempt downloaded it but crashed/stalled before
    // extraction — re-downloading hundreds of MB on slow links is wasteful).
    const fetchAssetZip = async (asset, zipPath, stage) => {
        if (fs.existsSync(zipPath)) {
            try {
                const existing = await validateDownload(zipPath, asset.size, asset.sha256);
                console.log(`[llamaDownloader] Reusing already-downloaded ${asset.name}`);
                return existing;
            } catch (_) {
                // validateDownload deleted the mismatching file — fall through
            }
        }
        progressWrap(stage, { percent: 0 });
        await downloadFile(asset.url, zipPath, (p) => {
            progressWrap(stage, p);
        }, cancelToken);
        return validateDownload(zipPath, asset.size, asset.sha256);
    };

    if (IS_MAC) {
        // ── Step 2 (macOS): single Metal tarball ─────────────────────────────
        console.log(`[llamaDownloader] macOS path: downloading ${MAC_ASSET}...`);
        const macAsset = findAsset(MAC_ASSET);
        const macTarPath = path.join(basePath, MAC_ASSET);
        installedAssets[macAsset.name] = await fetchAssetZip(macAsset, macTarPath, 'downloading-binary');

        progressWrap('extracting', { percent: 0 });
        console.log('[llamaDownloader] Extracting macOS tarball...');
        await safeExtractTarGz(macTarPath, basePath);
        try { fs.unlinkSync(macTarPath); } catch (_) {}

    } else if (useCuda) {
        // ── Step 2a: CUDA path — download main binary zip ────────────────────
        console.log(`[llamaDownloader] CUDA path: downloading ${CUDA_MAIN_ASSET}...`);
        const mainAsset = findAsset(CUDA_MAIN_ASSET);
        const mainZipPath = path.join(basePath, CUDA_MAIN_ASSET);
        installedAssets[mainAsset.name] = await fetchAssetZip(mainAsset, mainZipPath, 'downloading-binary');

        // ── Step 2b: CUDA path — download cudart runtime zip ─────────────────
        console.log(`[llamaDownloader] CUDA path: downloading ${CUDA_RT_ASSET}...`);
        const cudartAsset = findAsset(CUDA_RT_ASSET);
        const cudartZipPath = path.join(basePath, CUDA_RT_ASSET);
        installedAssets[cudartAsset.name] = await fetchAssetZip(cudartAsset, cudartZipPath, 'downloading-cudart');

        // ── Step 2c: Extract both ZIPs to the same directory ─────────────────
        progressWrap('extracting', { percent: 0 });
        console.log('[llamaDownloader] Extracting CUDA binary zip...');
        await safeExtractZip(mainZipPath, basePath, { requiredAnyBasenames: [LLAMA_BINARY_NAME] });
        try { fs.unlinkSync(mainZipPath); } catch (_) {}

        console.log('[llamaDownloader] Extracting cudart zip...');
        await safeExtractZip(cudartZipPath, basePath);
        try { fs.unlinkSync(cudartZipPath); } catch (_) {}

    } else {
        // ── Step 3: CPU path — download single zip ───────────────────────────
        console.log(`[llamaDownloader] CPU path: downloading ${CPU_ASSET}...`);
        const cpuAsset = findAsset(CPU_ASSET);
        const cpuZipPath = path.join(basePath, CPU_ASSET);
        installedAssets[cpuAsset.name] = await fetchAssetZip(cpuAsset, cpuZipPath, 'downloading-binary');

        // Extract
        progressWrap('extracting', { percent: 0 });
        console.log('[llamaDownloader] Extracting CPU binary zip...');
        await safeExtractZip(cpuZipPath, basePath, { requiredAnyBasenames: [LLAMA_BINARY_NAME] });
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

    // Belt-and-braces on macOS: tar normally preserves the execute bit, but a
    // stripped mode would make spawn() fail with EACCES.
    if (IS_MAC) {
        try { fs.chmodSync(binaryPath, 0o755); } catch (_) {}
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

// Serialize concurrent downloadBinary calls. main.cjs reaches this from several
// independent paths (startup ensure, transcription-complete, settings, model
// downloads); two interleaved runs would write the same .partial zip with mixed
// 'w'/'a' flags and corrupt each other's download.
let _binaryDownloadChain = Promise.resolve();

const downloadBinary = (onProgress, useCuda = true, cancelToken) => {
    const run = _binaryDownloadChain
        .catch(() => {}) // a failed predecessor must not poison the chain
        .then(() => downloadBinaryInternal(onProgress, useCuda, cancelToken));
    _binaryDownloadChain = run;
    return run;
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
    getBinaryStatus,
    isBinaryCompatibleWithMode,
    checkPartialDownloads,
    validateDownload,
    ensureDiskSpace,
    events: emitter,  // EventEmitter for Phase 8 UI subscription
    MODELS,           // Expose for Phase 5/8 to list available models
    // Constants exposed for callers
    PINNED_TAG,
};
