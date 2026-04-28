// Downloads whisper.cpp binary (multi-backend) and GGML model files
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const whisperCpp = require('./whisperCppService.cjs');
const gpuDetector = require('./gpuDetector.cjs');

// GitHub API for whisper.cpp releases (repo migrated to ggml-org)
const GITHUB_API_RELEASES = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest';

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
};

/**
 * HTTP(S) GET that follows redirects (HuggingFace uses 302s).
 */
const httpGet = (url, options = {}) => {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.get(url, {
            headers: { 'User-Agent': 'Quilly/1.0' },
            ...options,
        }, (res) => {
            // Follow redirects (301, 302, 307, 308)
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                resolve(httpGet(res.headers.location, options));
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
        res.on('data', (chunk) => {
            downloaded += chunk.length;
            fileStream.write(chunk);
            if (onProgress && total > 0) {
                onProgress({
                    downloaded,
                    total,
                    percent: Math.round((downloaded / total) * 100),
                });
            }
        });

        res.on('end', () => {
            fileStream.end(() => {
                // Rename from .partial to final name
                fs.renameSync(partialPath, destPath);
                resolve(destPath);
            });
        });

        res.on('error', (err) => {
            fileStream.destroy();
            try { fs.unlinkSync(partialPath); } catch (_) {}
            reject(err);
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
                        resolve({
                            url: asset.browser_download_url,
                            name: asset.name,
                            size: asset.size,
                            digest: asset.digest || null,
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
    safeExtractZip(zipPath, basePath, { requiredAnyBasenames: ['whisper-cli.exe', 'main.exe'] });

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

    const url = `${HF_MODEL_BASE}/${ggmlName}`;
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
