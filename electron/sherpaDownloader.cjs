// Downloads + validates the sherpa-onnx speaker-diarization sidecar (binary
// plus the two ONNX models). Mirrors whisperCppDownloader: pinned release
// tag, sha256 tables, .partial download with stall watchdog, validate-or-
// delete, native extraction via the platform layer.
//
// Windows-only for v1 — setup() throws on other platforms (spec:
// .planning/specs/2026-07-17-speaker-diarization-design.md).

const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const platformUtils = require('./platformUtils.cjs');

// Loadable under plain `node --test` (no Electron): app is resolved lazily.
let app = null;
try { ({ app } = require('electron')); } catch (_) { /* tests run without electron */ }

const PINNED_TAG = 'v1.13.4';
const BIN_DIR_NAME = `sherpa-onnx-${PINNED_TAG}-win-x64-shared-MD-Release-no-tts`;
const BINARY_EXE = 'sherpa-onnx-offline-speaker-diarization.exe';
const SEGMENTATION_DIR = 'sherpa-onnx-pyannote-segmentation-3-0';

// Verified 2026-07-17: downloaded, hashed, and smoke-tested on the
// 0-four-speakers-zh.wav sample (RTF ≈ 0.09 CPU).
const ASSETS = {
    binary: {
        url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/${PINNED_TAG}/${BIN_DIR_NAME}.tar.bz2`,
        archiveName: `${BIN_DIR_NAME}.tar.bz2`,
        size: 18_746_895,
        sha256: 'da8eb60079df2969b7691517c2dd6f4965a0481533b200c3bf25f5e7f7f65b80',
    },
    segmentation: {
        url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/${SEGMENTATION_DIR}.tar.bz2`,
        archiveName: `${SEGMENTATION_DIR}.tar.bz2`,
        // No size pin — sha256 is authoritative for model archives.
        sha256: '24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488',
    },
    embedding: {
        // NOTE: 'speaker-recongition-models' typo is the real upstream tag name.
        url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx',
        fileName: 'nemo_en_titanet_small.onnx',
        size: 40_257_283,
        sha256: 'ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e',
    },
};

const getBasePath = () => {
    if (!app) throw new Error('sherpaDownloader requires Electron (app unavailable)');
    return path.join(app.getPath('userData'), 'sherpa-diarization');
};

const getModelsPath = () => path.join(getBasePath(), 'models');

const getBinaryPath = () => {
    const p = path.join(getBasePath(), BIN_DIR_NAME, 'bin', BINARY_EXE);
    return fs.existsSync(p) ? p : null;
};

const getModelPaths = () => {
    const segmentation = path.join(getModelsPath(), SEGMENTATION_DIR, 'model.onnx');
    const embedding = path.join(getModelsPath(), ASSETS.embedding.fileName);
    if (!fs.existsSync(segmentation) || !fs.existsSync(embedding)) return null;
    return { segmentation, embedding };
};

const isInstalled = () => Boolean(getBinaryPath() && getModelPaths());

// ─── download helpers (mirrored from whisperCppDownloader) ──────────────────

/** HTTP(S) GET that follows redirects (GitHub release assets use 302s). */
const httpGet = (url, options = {}, redirectDepth = 0) => {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.get(url, {
            headers: { 'User-Agent': 'Quilly/1.0' },
            ...options,
        }, (res) => {
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
            try { fs.unlinkSync(partialPath); } catch (_) { /* ignore */ }
            reject(err);
        };

        // Stall watchdog: no data for 60s → fail instead of hanging the UI.
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

        res.pipe(fileStream);

        fileStream.on('error', (err) => {
            fail(new Error(`Disk write failed: ${err.message}`));
        });

        fileStream.on('finish', () => {
            if (settled) return;
            if (stallTimer) clearTimeout(stallTimer);
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

        res.on('close', () => {
            if (!settled && !res.complete) {
                fail(new Error('Connection closed before download completed'));
            }
        });
    });
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

const validateDownload = async (destPath, expectedSize, expectedSha256) => {
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
    if (expectedSha256 && sha256 !== expectedSha256) {
        fs.unlinkSync(destPath);
        throw new Error(
            `Download checksum mismatch for ${path.basename(destPath)}. ` +
            `File deleted. Please retry the download.`
        );
    }
};

// ─── setup ───────────────────────────────────────────────────────────────────

/**
 * Download and install the diarization binary + models. Idempotent — pieces
 * already on disk are skipped. Throws on any failure (caller surfaces it).
 * @param {function} onProgress - ({stage, percent}) => void;
 *   stage ∈ 'binary' | 'segmentation' | 'embedding' | 'extracting'
 */
const setup = async (onProgress = () => {}) => {
    if (process.platform !== 'win32') {
        throw new Error('Speaker detection is currently Windows-only');
    }

    const base = getBasePath();
    const modelsDir = getModelsPath();
    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(modelsDir, { recursive: true });

    // 1. CLI binary archive
    if (!getBinaryPath()) {
        const archivePath = path.join(base, ASSETS.binary.archiveName);
        await downloadFile(ASSETS.binary.url, archivePath, ({ percent }) =>
            onProgress({ stage: 'binary', percent }));
        await validateDownload(archivePath, ASSETS.binary.size, ASSETS.binary.sha256);
        onProgress({ stage: 'extracting', percent: 100 });
        try {
            await platformUtils.extractArchive(archivePath, base);
            if (!getBinaryPath()) {
                throw new Error(`Extracted archive is missing ${BINARY_EXE}`);
            }
        } finally {
            try { fs.unlinkSync(archivePath); } catch (_) { /* ignore */ }
        }
    }

    // 2. Segmentation model archive
    const segModel = path.join(modelsDir, SEGMENTATION_DIR, 'model.onnx');
    if (!fs.existsSync(segModel)) {
        const archivePath = path.join(modelsDir, ASSETS.segmentation.archiveName);
        await downloadFile(ASSETS.segmentation.url, archivePath, ({ percent }) =>
            onProgress({ stage: 'segmentation', percent }));
        await validateDownload(archivePath, null, ASSETS.segmentation.sha256);
        onProgress({ stage: 'extracting', percent: 100 });
        try {
            await platformUtils.extractArchive(archivePath, modelsDir);
            if (!fs.existsSync(segModel)) {
                throw new Error('Extracted segmentation archive is missing model.onnx');
            }
        } finally {
            try { fs.unlinkSync(archivePath); } catch (_) { /* ignore */ }
        }
    }

    // 3. Embedding model (raw .onnx, no extraction)
    const embModel = path.join(modelsDir, ASSETS.embedding.fileName);
    if (!fs.existsSync(embModel)) {
        await downloadFile(ASSETS.embedding.url, embModel, ({ percent }) =>
            onProgress({ stage: 'embedding', percent }));
        await validateDownload(embModel, ASSETS.embedding.size, ASSETS.embedding.sha256);
    }

    return { success: true };
};

module.exports = {
    ASSETS,
    isInstalled,
    getBinaryPath,
    getModelPaths,
    getBasePath,
    setup,
};
