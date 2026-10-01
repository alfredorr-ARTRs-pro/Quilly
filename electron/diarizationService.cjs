// Speaker diarization via the sherpa-onnx offline-speaker-diarization CLI.
// Spawn conventions mirror whisperCppService (windowsHide, cwd=binary dir,
// stderr ring buffer, duration-scaled kill timer).

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

// Turn lines look like: "0.318 -- 6.865 speaker_00" (stdout also carries a
// config dump and "Started" banner — anything not matching is ignored).
const TURN_LINE_RE = /^\s*(\d+(?:\.\d+)?)\s*--\s*(\d+(?:\.\d+)?)\s+speaker_(\d+)\s*$/;

const parseDiarizationOutput = (stdout) => {
    const turns = [];
    for (const line of String(stdout || '').split(/\r?\n/)) {
        const m = TURN_LINE_RE.exec(line);
        if (m) {
            turns.push({ start: parseFloat(m[1]), end: parseFloat(m[2]), speaker: parseInt(m[3], 10) });
        }
    }
    return turns;
};

// Measured RTF ≈ 0.09 on CPU (v1.13.4, titanet_small); 1×duration + 60s of
// model-load headroom is a generous ceiling, 120s floor like whisper.
const computeDiarizationTimeout = (durationSecs) => {
    if (!Number.isFinite(durationSecs) || durationSecs <= 0) return 120;
    return Math.max(120, Math.ceil(60 + durationSecs));
};

/**
 * Run speaker diarization on a 16kHz mono WAV file.
 * @param {string} wavPath
 * @param {{numSpeakers?: number|null, durationSecs?: number}} options
 *   numSpeakers: known speaker count (>=1) → fixed clustering; null → auto (threshold).
 * @returns {Promise<{success: boolean, turns?: Array<{start,end,speaker}>, error?: string}>}
 */
const diarize = (wavPath, { numSpeakers = null, durationSecs = 0 } = {}) => {
    // Lazy require: keeps this module loadable under plain node --test.
    const sherpaDownloader = require('./sherpaDownloader.cjs');
    return new Promise((resolve) => {
        const binaryPath = sherpaDownloader.getBinaryPath();
        const models = sherpaDownloader.getModelPaths();
        if (!binaryPath || !models) {
            resolve({ success: false, error: 'Speaker detection engine not installed' });
            return;
        }

        const threads = Math.min(8, Math.max(2, os.cpus().length - 2));
        const args = [
            `--segmentation.pyannote-model=${models.segmentation}`,
            `--embedding.model=${models.embedding}`,
            `--segmentation.num-threads=${threads}`,
            `--embedding.num-threads=${threads}`,
        ];
        if (Number.isInteger(numSpeakers) && numSpeakers >= 1) {
            args.push(`--clustering.num-clusters=${numSpeakers}`);
        } else {
            args.push('--clustering.cluster-threshold=0.5');
        }
        args.push(wavPath);

        console.log(`[diarize] Running: ${binaryPath} ${args.join(' ')}`);
        const proc = spawn(binaryPath, args, {
            cwd: path.dirname(binaryPath),
            windowsHide: true,
        });

        let stdout = '';
        let stderrOutput = '';
        proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        proc.stderr.on('data', (chunk) => {
            stderrOutput += chunk.toString();
            if (stderrOutput.length > 8192) stderrOutput = stderrOutput.slice(-4096);
        });

        const timeoutSecs = computeDiarizationTimeout(durationSecs);
        const timer = setTimeout(() => {
            proc.kill();
            resolve({ success: false, error: `Speaker detection timed out after ${timeoutSecs}s` });
        }, timeoutSecs * 1000);

        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                resolve({ success: false, error: `sherpa-onnx exited with code ${code}: ${stderrOutput.slice(-400)}` });
                return;
            }
            resolve({ success: true, turns: parseDiarizationOutput(stdout) });
        });

        proc.on('error', (err) => {
            clearTimeout(timer);
            resolve({ success: false, error: `Failed to spawn sherpa-onnx: ${err.message}` });
        });
    });
};

module.exports = { diarize, parseDiarizationOutput, computeDiarizationTimeout };
