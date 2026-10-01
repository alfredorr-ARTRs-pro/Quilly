// Downloads whisper.cpp binary (multi-backend) and GGML model files
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const whisperCpp = require('./whisperCppService.cjs');
const gpuDetector = require('./gpuDetector.cjs');
const platformUtils = require('./platformUtils.cjs');

// Pinned whisper.cpp release (repo migrated to ggml-org). Pinning matches the
// llama.cpp downloader's reproducible-binary policy: an upstream release we
// haven't reviewed can no longer silently change what users install.
// v1.9.1 (2026-06-19) ships whisper-cli AND parakeet-cli in every Windows zip.
const PINNED_WHISPER_TAG = 'v1.9.1';
const GITHUB_API_RELEASES = `https://api.github.com/repos/ggml-org/whisper.cpp/releases/tags/${PINNED_WHISPER_TAG}`;

// Pinned sha256 digests for the v1.9.1 Windows assets (from the GitHub API,
// cross-verified by local download 2026-07-02). Used to validate downloads even
// if the API stops returning digest fields.
const EXPECTED_WHISPER_ASSETS = {
    'whisper-bin-x64.zip': {
        size: 7_982_101,
        sha256: '7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539',
    },
    'whisper-blas-bin-x64.zip': {
        size: 20_769_031,
        sha256: '3c319eab3e87f85883e1ff3d14426c0a1986c661c5eb5985e8af431ed9c4f71f',
    },
    'whisper-cublas-11.8.0-bin-x64.zip': {
        size: 278_557_654,
        sha256: 'aecdce0e4d4bb758a7c72a31f3f9f19a7b6d861405fd2da743cd86398633c963',
    },
    'whisper-cublas-12.4.0-bin-x64.zip': {
        size: 677_887_125,
        sha256: '106a2030eff8998e4ef320fe72e263a78449e9040386ee27c41ea80b001b601b',
    },
};

// ── macOS engine build ────────────────────────────────────────────────────────
// Upstream whisper.cpp releases ship NO macOS CLI binaries (only Windows/
// Ubuntu zips and an xcframework), so Quilly builds whisper-cli + parakeet-cli
// itself on a macOS runner (.github/workflows/build-whisper-macos.yml) and
// publishes the zip on a fixed engine release tag in the Quilly repo.
//
// size/sha256 are null until that workflow has run once; a null pin makes the
// darwin download path fail with a clear message (the app then uses the
// Transformers.js fallback). Fill both values from the workflow's output in a
// follow-up commit — never from an unverified local build.
const MAC_WHISPER_ASSET = 'whisper-v1.9.1-macos-arm64.zip';
const MAC_WHISPER_URL = `https://github.com/alfredorr-ARTRs-pro/Quilly/releases/download/engine-whisper-${PINNED_WHISPER_TAG}-macos/${MAC_WHISPER_ASSET}`;
const MAC_WHISPER_PIN = { size: null, sha256: null };

// Asset patterns per backend — tried in order if the requested one isn't found
const BACKEND_PATTERNS = {
    cuda12:  /whisper-cublas-12[\d.]*-bin-x64\.zip/i,
    cuda11:  /whisper-cublas-11[\d.]*-bin-x64\.zip/i,
    vulkan:  /whisper-vulkan[\w-]*-bin-x64\.zip/i,  // Ready for future releases
    openblas:/whisper-blas-bin-x64\.zip/i,
    cpu:     /^whisper-bin-x64\.zip$/i,
};

// Fallback chain: if the requested backend asset isn't in the release,
// try the next-best option.
const FALLBACK_CHAIN = {
    cuda12:  ['cuda12', 'cuda11', 'openblas', 'cpu'],
    cuda11:  ['cuda11', 'cuda12', 'openblas', 'cpu'],
    vulkan:  ['vulkan', 'openblas', 'cpu'],
    openblas:['openblas', 'cpu'],
    cpu:     ['cpu'],
};

// HuggingFace base URL for GGML models
const HF_MODEL_REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1';
const HF_MODEL_BASE = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${HF_MODEL_REVISION}`;

const MODEL_METADATA = {
    'ggml-tiny.en.bin': {
        size: 77_704_715,
        sha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f',
    },
    'ggml-base.bin': {
        size: 147_951_465,
        sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
    },
    'ggml-small.bin': {
        size: 487_601_967,
        sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
    },
    'ggml-medium.bin': {
        size: 1_533_763_059,
        sha256: '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208',
    },
    'ggml-large-v3.bin': {
        size: 3_095_033_483,
        sha256: '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2',
    },
    'ggml-large-v3-turbo.bin': {
        size: 1_624_555_275,
        sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
    },
    // NVIDIA Parakeet lives in a different HF repo than the whisper GGMLs, so
    // this entry carries its own pinned download URL.
    'ggml-parakeet-tdt-0.6b-v3-f16.bin': {
        size: 1_255_897_319,
        sha256: '833bffc9513b2cae867ee9e51633cfd11e4d51aaa5597c8ac02159385a2b426f',
        url: 'https://huggingface.co/ggml-org/parakeet-GGUF/resolve/35156454d1a39de06863303dd209fd2bed6ee079/ggml-parakeet-tdt-0.6b-v3-f16.bin',
    },
};

/**
 * HTTP(S) GET that follows redirects (HuggingFace uses 302s).
 */
const httpGet = (url, options = {}, redirectDepth = 0) => {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.get(url, {
            headers: { 'User-Agent': 'Quilly/1.0' },
            ...options,
        }, (res) => {
            // Follow redirects (301, 302, 307, 308) — bounded, with the 3xx body
            // drained so keep-alive sockets are not leaked per hop.
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                if (redirectDepth >= 5) {
                    reject(new Error(`Too many redirects for ${url}`));
                    return;
                }
                resolve(httpGet(res.headers.location, options, redirectDepth + 1));
                return;
            }
            if (res.statusCode !== 200) {
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
    });
};

/**
 * Download a file to disk with progress callback.
 * @param {string} url
 * @param {string} destPath
 * @param {function} onProgress - ({downloaded, total, percent}) => void
 */
const downloadFile = async (url, destPath, onProgress) => {
    const partialPath = destPath + '.partial';

    const res = await httpGet(url);
    const total = parseInt(res.headers['content-length'], 10) || 0;
    let downloaded = 0;

    const fileStream = fs.createWriteStream(partialPath);

    return new Promise((resolve, reject) => {
        let settled = false;
        let stallTimer = null;
        const fail = (err) => {
            if (settled) return;
            settled = true;
            if (stallTimer) clearTimeout(stallTimer);
            res.destroy();
            fileStream.destroy();
            try { fs.unlinkSync(partialPath); } catch (_) {}
            reject(err);
        };

        // Stall watchdog: a silently-dead socket after headers would hang this
        // promise (and the download UI) forever. No data for 60s → fail.
        const armStallTimer = () => {
            if (stallTimer) clearTimeout(stallTimer);
            stallTimer = setTimeout(() => {
                fail(new Error('Download stalled — no data received for 60s'));
            }, 60_000);
        };
        armStallTimer();

        res.on('data', (chunk) => {
            armStallTimer();
            downloaded += chunk.length;
            if (onProgress && total > 0) {
                onProgress({
                    downloaded,
                    total,
                    percent: Math.round((downloaded / total) * 100),
                });
            }
        });

        // pipe() writes with backpressure; the 'data' listener above only
        // observes chunks for progress reporting.
        res.pipe(fileStream);

        // Without this handler a disk-full/AV-lock write error is an unhandled
        // 'error' event → uncaughtException, and the promise never settles
        // (download UI hangs forever).
        fileStream.on('error', (err) => {
            fail(new Error(`Disk write failed: ${err.message}`));
        });

        fileStream.on('finish', () => {
            if (settled) return;
            if (stallTimer) clearTimeout(stallTimer);
            // Rename from .partial to final name — routed through reject rather
            // than thrown inside the stream callback.
            try {
                fs.renameSync(partialPath, destPath);
                settled = true;
                resolve(destPath);
            } catch (err) {
                settled = true;
                reject(err);
            }
        });

        res.on('error', (err) => fail(err));

        // A destroyed/aborted socket emits 'close' without 'error' — convert an
        // incomplete body into a failure instead of hanging forever.
        res.on('close', () => {
            if (!settled && !res.complete) {
                fail(new Error('Connection closed before download completed'));
            }
        });
    });
};

const normalizeSha256 = (digest) => {
    if (!digest) return null;
    const normalized = String(digest).trim().toLowerCase().replace(/^sha256:/, '');
    return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
};

const hashFile = (filePath, algorithm = 'sha256') => {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash(algorithm);
        const stream = fs.createReadStream(filePath);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
};

const validateDownload = async (destPath, expectedSize, expectedSha256 = null) => {
    if (!fs.existsSync(destPath)) {
        throw new Error(`Downloaded file not found: ${destPath}`);
    }

    const actualSize = fs.statSync(destPath).size;
    if (expectedSize && actualSize !== expectedSize) {
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

// Native extraction in a child process via the platform layer — adm-zip's
// extractAllTo runs synchronously on the Electron main thread (freezes the
// UI) and is pathologically slow on huge entries (observed live 2026-07-02).
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
 * Fetch the latest release from GitHub and find the best asset for
 * the given backend, with fallback through the chain.
 *
 * @param {string} backend - 'cuda12' | 'cuda11' | 'vulkan' | 'openblas' | 'cpu'
 * @returns {Promise<{url, name, size, digest, tag, backend}>}
 */
const findBestAsset = async (backend) => {
    const res = await httpGet(GITHUB_API_RELEASES);

    return new Promise((resolve, reject) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            try {
                const release = JSON.parse(data);
                const chain = FALLBACK_CHAIN[backend] || FALLBACK_CHAIN.openblas;

                for (const candidate of chain) {
                    const pattern = BACKEND_PATTERNS[candidate];
                    const asset = release.assets.find(a => pattern.test(a.name));
                    if (asset) {
                        if (candidate !== backend) {
                            console.log(`[downloader] ${backend} asset not found, falling back to ${candidate}`);
                        }
                        // Cross-check against our locally pinned metadata: the
                        // release tag is pinned, so any size OR digest
                        // disagreement means the asset was replaced upstream —
                        // refuse it. The download is then validated against OUR
                        // pinned sha256, never the API-reported one.
                        const expected = EXPECTED_WHISPER_ASSETS[asset.name];
                        if (expected) {
                            if (asset.size !== expected.size) {
                                reject(new Error(`Asset ${asset.name} does not match pinned size for ${PINNED_WHISPER_TAG}`));
                                return;
                            }
                            const apiSha256 = normalizeSha256(asset.digest);
                            if (apiSha256 && apiSha256 !== expected.sha256) {
                                reject(new Error(`Asset ${asset.name} does not match pinned sha256 for ${PINNED_WHISPER_TAG}`));
                                return;
                            }
                        }
                        resolve({
                            url: asset.browser_download_url,
                            name: asset.name,
                            size: asset.size,
                            digest: expected?.sha256 || asset.digest || null,
                            tag: release.tag_name,
                            backend: candidate,
                        });
                        return;
                    }
                }

                reject(new Error(`No suitable binary asset found in release ${release.tag_name}`));
            } catch (e) {
                reject(new Error(`Failed to parse GitHub release: ${e.message}`));
            }
        });
        res.on('error', reject);
    });
};

/**
 * Download and extract the whisper.cpp binary for the best backend.
 *
 * @param {function} onProgress - progress callback
 * @param {string} [backend] - override auto-detection ('cuda12', 'cuda11', 'openblas', 'cpu')
 * @returns {Promise<{success, binaryPath, tag, backend}>}
 */
const downloadBinary = async (onProgress, backend) => {
    const basePath = whisperCpp.getBasePath();
    fs.mkdirSync(basePath, { recursive: true });

    // macOS: single Metal build from the Quilly engine release — no backend
    // detection or fallback chain applies.
    if (process.platform === 'darwin') {
        return downloadBinaryMac(basePath, onProgress);
    }

    // Auto-detect if no explicit backend provided
    if (!backend) {
        const gpuInfo = await gpuDetector.detectGpu();
        backend = gpuInfo.recommended;
        console.log(`[downloader] Auto-detected backend: ${backend}`);
    }

    console.log(`[downloader] Finding latest whisper.cpp release (${backend})...`);
    const asset = await findBestAsset(backend);
    console.log(`[downloader] Found: ${asset.name} (${asset.tag}, ${(asset.size / 1024 / 1024).toFixed(1)}MB, backend=${asset.backend})`);

    // Download zip
    const zipPath = path.join(basePath, asset.name);
    if (onProgress) onProgress({ stage: 'downloading', percent: 0 });
    await downloadFile(asset.url, zipPath, (p) => {
        if (onProgress) onProgress({ stage: 'downloading', ...p });
    });
    const validation = await validateDownload(zipPath, asset.size, asset.digest);

    // Extract zip
    if (onProgress) onProgress({ stage: 'extracting', percent: 0 });
    console.log('[downloader] Extracting...');
    await safeExtractZip(zipPath, basePath, { requiredAnyBasenames: ['whisper-cli.exe', 'main.exe'] });

    // Clean up zip
    try { fs.unlinkSync(zipPath); } catch (_) {}

    // Write a marker file so we know which backend is installed
    try {
        fs.writeFileSync(path.join(basePath, '.backend'), asset.backend, 'utf-8');
        fs.writeFileSync(path.join(basePath, 'manifest.json'), JSON.stringify({
            binary: {
                tag: asset.tag,
                backend: asset.backend,
                asset: asset.name,
                size: validation.size,
                sha256: validation.sha256,
                installedAt: new Date().toISOString(),
            },
        }, null, 2), 'utf-8');
    } catch (_) {}

    // Verify binary exists
    const binaryPath = whisperCpp.findBinary();
    if (!binaryPath) {
        throw new Error('Extraction succeeded but binary not found. Check ' + basePath);
    }

    if (onProgress) onProgress({ stage: 'done', percent: 100 });
    console.log(`[downloader] Binary installed at: ${binaryPath} (backend: ${asset.backend})`);

    return { success: true, binaryPath, tag: asset.tag, backend: asset.backend };
};

/**
 * macOS engine install: download the CI-built whisper zip from the Quilly
 * repo's engine release, validate against the local pin, extract, mark the
 * backend as 'metal'.
 */
const downloadBinaryMac = async (basePath, onProgress) => {
    if (!MAC_WHISPER_PIN.size || !MAC_WHISPER_PIN.sha256) {
        throw new Error(
            'macOS speech engine build not published yet — Quilly will use the built-in fallback engine'
        );
    }

    console.log(`[downloader] macOS: downloading ${MAC_WHISPER_ASSET}...`);
    const zipPath = path.join(basePath, MAC_WHISPER_ASSET);
    if (onProgress) onProgress({ stage: 'downloading', percent: 0 });
    await downloadFile(MAC_WHISPER_URL, zipPath, (p) => {
        if (onProgress) onProgress({ stage: 'downloading', ...p });
    });
    const validation = await validateDownload(zipPath, MAC_WHISPER_PIN.size, MAC_WHISPER_PIN.sha256);

    if (onProgress) onProgress({ stage: 'extracting', percent: 0 });
    console.log('[downloader] Extracting...');
    await safeExtractZip(zipPath, basePath, { requiredAnyBasenames: ['whisper-cli', 'main'] });
    try { fs.unlinkSync(zipPath); } catch (_) {}

    // Belt-and-braces: zip extraction may strip the execute bit.
    for (const name of ['whisper-cli', 'main', 'parakeet-cli']) {
        for (const sub of ['', 'Release', 'bin']) {
            const p = path.join(basePath, sub, name);
            if (fs.existsSync(p)) {
                try { fs.chmodSync(p, 0o755); } catch (_) {}
            }
        }
    }

    try {
        fs.writeFileSync(path.join(basePath, '.backend'), 'metal', 'utf-8');
        fs.writeFileSync(path.join(basePath, 'manifest.json'), JSON.stringify({
            binary: {
                tag: PINNED_WHISPER_TAG,
                backend: 'metal',
                asset: MAC_WHISPER_ASSET,
                size: validation.size,
                sha256: validation.sha256,
                installedAt: new Date().toISOString(),
            },
        }, null, 2), 'utf-8');
    } catch (_) {}

    const binaryPath = whisperCpp.findBinary();
    if (!binaryPath) {
        throw new Error('Extraction succeeded but binary not found. Check ' + basePath);
    }

    if (onProgress) onProgress({ stage: 'done', percent: 100 });
    console.log(`[downloader] Binary installed at: ${binaryPath} (backend: metal)`);

    return { success: true, binaryPath, tag: PINNED_WHISPER_TAG, backend: 'metal' };
};

/**
 * Download a GGML model file.
 * @param {string} modelId - e.g. 'Xenova/whisper-base'
 * @param {function} onProgress - progress callback
 * @returns {Promise<{success, modelPath}>}
 */
const downloadModel = async (modelId, onProgress) => {
    const ggmlName = whisperCpp.MODEL_ID_TO_GGML[modelId];
    if (!ggmlName) {
        throw new Error(`Unknown model ID: ${modelId}`);
    }

    const modelsPath = whisperCpp.getModelsPath();
    fs.mkdirSync(modelsPath, { recursive: true });

    const modelPath = path.join(modelsPath, ggmlName);
    const metadata = MODEL_METADATA[ggmlName];
    if (fs.existsSync(modelPath)) {
        const existingSize = fs.statSync(modelPath).size;
        if (
            metadata &&
            existingSize === metadata.size &&
            await hashFile(modelPath, 'sha256') === metadata.sha256
        ) {
            console.log(`[downloader] Model already exists: ${modelPath}`);
            return { success: true, modelPath };
        }
        fs.unlinkSync(modelPath);
    }

    const url = metadata?.url || `${HF_MODEL_BASE}/${ggmlName}`;
    console.log(`[downloader] Downloading model: ${ggmlName} from ${url}`);

    if (onProgress) onProgress({ stage: 'downloading', percent: 0 });
    await downloadFile(url, modelPath, (p) => {
        if (onProgress) onProgress({ stage: 'downloading', ...p });
    });
    await validateDownload(modelPath, metadata?.size, metadata?.sha256);

    if (onProgress) onProgress({ stage: 'done', percent: 100 });
    console.log(`[downloader] Model installed at: ${modelPath}`);

    return { success: true, modelPath };
};

module.exports = {
    downloadBinary,
    downloadModel,
    findBestAsset,
};
