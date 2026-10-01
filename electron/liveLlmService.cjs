'use strict';

// Optional tiny-model cleanup helper.
//
// The main live dictation feature works without this service. When the user
// enables final transcript cleanup and the tiny model/runtime are installed, this
// service runs a separate llama-server on its own port so it does not
// swap the existing Qwen 4B/9B text-processing server.

const { spawn: nodeSpawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const llamaDownloader = require('./llamaDownloader.cjs');
const platformUtils = require('./platformUtils.cjs');
const {
    DEFAULT_FINAL_CLEANUP_PROMPT,
    sanitizeLocalStructureRules,
} = require('./promptConfig.cjs');

const LIVE_MODEL_ID = 'qwen3.5-0.8b-live';
const LIVE_PORT = 8788;
const IDLE_KILL_MS = 30_000;

let _proc = null;
let _ready = false;
let _lastError = null;
let _queue = Promise.resolve();
let _gpuMode = 'auto';
let _busy = false;
let _startupPromise = null;
let _idleKillTimer = null;

const enqueue = (fn) => {
    const task = _queue.then(fn);
    _queue = task.catch(() => {});
    return task;
};

const getModelPath = () => {
    const model = llamaDownloader.MODELS[LIVE_MODEL_ID];
    if (!model) return null;
    return path.join(llamaDownloader.getModelsPath(), model.filename);
};

const isModelInstalled = () => {
    const modelPath = getModelPath();
    return !!(modelPath && fs.existsSync(modelPath));
};

const getStatus = () => ({
    modelId: LIVE_MODEL_ID,
    binaryInstalled: !!llamaDownloader.findBinary(),
    modelInstalled: isModelInstalled(),
    running: !!_proc,
    ready: _ready,
    busy: _busy,
    port: LIVE_PORT,
    gpuMode: _gpuMode,
    lastError: _lastError,
});

const setGpuMode = (mode) => {
    _gpuMode = ['auto', 'gpu', 'cpu'].includes(mode) ? mode : 'auto';
};

const clearIdleKillTimer = () => {
    if (_idleKillTimer) {
        clearTimeout(_idleKillTimer);
        _idleKillTimer = null;
    }
};

const scheduleIdleKill = () => {
    clearIdleKillTimer();
    _idleKillTimer = setTimeout(() => {
        kill().catch(err => {
            _lastError = err.message;
        });
    }, IDLE_KILL_MS);
};

const getNGpuLayers = async () => {
    if (_gpuMode === 'cpu') return 0;

    try {
        const gpuDetector = require('./gpuDetector.cjs');
        const gpu = await gpuDetector.detectGpu();
        // CUDA on Windows, Metal on Apple Silicon — both take full offload.
        const hasUsableGpu = ['cuda12', 'cuda11', 'metal'].includes(gpu.recommended);
        if (hasUsableGpu) return 999;
        if (_gpuMode === 'gpu') {
            throw new Error('GPU mode requested but no compatible GPU was detected');
        }
    } catch (err) {
        if (_gpuMode === 'gpu') throw err;
        _lastError = err.message;
    }

    return 0;
};

const pollHealth = (timeoutMs = 30000, intervalMs = 300) =>
    new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;

        const check = () => {
            if (Date.now() >= deadline) {
                reject(new Error('live llama-server health timeout'));
                return;
            }

            const req = http.get(`http://localhost:${LIVE_PORT}/health`, (res) => {
                res.resume();
                if (res.statusCode === 200) {
                    resolve();
                    return;
                }
                setTimeout(check, intervalMs);
            });

            req.on('error', () => setTimeout(check, intervalMs));
            req.end();
        };

        check();
    });

const kill = async ({ resetBusy = true, resetStartup = true } = {}) => {
    clearIdleKillTimer();
    if (resetStartup) _startupPromise = null;
    if (resetBusy) _busy = false;

    if (!_proc) return;

    const pid = _proc.pid;
    const proc = _proc;
    _proc = null;
    _ready = false;

    await platformUtils.killPid(pid);

    proc.removeAllListeners();
};

const ensureServer = async () => {
    if (_proc && _ready) return;
    if (_startupPromise) return _startupPromise;

    _startupPromise = (async () => {
        const binaryPath = llamaDownloader.findBinary();
        const modelPath = getModelPath();

        if (!binaryPath) {
            throw new Error('llama-server binary not installed');
        }
        if (!modelPath || !fs.existsSync(modelPath)) {
            throw new Error('live cleanup model not installed');
        }

        await kill({ resetBusy: false, resetStartup: false });
        const nGpuLayers = await getNGpuLayers();
        console.log(`[liveLlmService] starting tiny cleanup server model=${path.basename(modelPath)} port=${LIVE_PORT} nGpuLayers=${nGpuLayers} gpuMode=${_gpuMode}`);

        const args = [
            '--model', modelPath,
            '--port', String(LIVE_PORT),
            '--host', '127.0.0.1',
            '--n-gpu-layers', String(nGpuLayers),
            '--ctx-size', '4096',
            '--parallel', '1',
        ];

        _lastError = null;
        _ready = false;
        _proc = nodeSpawn(binaryPath, args, {
            cwd: path.dirname(binaryPath),
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stderrBuffer = '';
        _proc.stderr.on('data', (chunk) => {
            stderrBuffer += chunk.toString();
            if (stderrBuffer.length > 8192) stderrBuffer = stderrBuffer.slice(-4096);
        });

        _proc.on('close', (code) => {
            if (_proc) {
                _proc = null;
                _ready = false;
            }
            if (code !== 0 && stderrBuffer) {
                _lastError = stderrBuffer.slice(-1000);
            }
        });

        _proc.on('error', (err) => {
            _proc = null;
            _ready = false;
            _lastError = err.message;
        });

        await pollHealth();
        _ready = true;
    })();

    try {
        await _startupPromise;
    } finally {
        _startupPromise = null;
    }
};

const postInference = (messages, temperature = 0.1, maxTokens = 384) =>
    new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify({ messages, temperature, stream: false, max_tokens: maxTokens });
        const req = http.request({
            hostname: 'localhost',
            port: LIVE_PORT,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr),
            },
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    const content = parsed?.choices?.[0]?.message?.content;
                    if (!content) {
                        reject(new Error('Invalid live cleanup response'));
                        return;
                    }
                    resolve(content);
                } catch (err) {
                    reject(new Error(`Bad live cleanup response: ${err.message}`));
                }
            });
        });

        req.on('error', (err) => reject(new Error(`Live cleanup request failed: ${err.message}`)));
        req.write(bodyStr);
        req.end();
    });

const extractJson = (text) => {
    const raw = String(text || '').trim();
    if (!raw) throw new Error('Empty live cleanup output');

    try {
        return JSON.parse(raw);
    } catch (_) {
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) throw new Error('Live cleanup output did not contain JSON');
        return JSON.parse(match[0]);
    }
};

// <think>-stripping lives in textUtils.cjs so this module and pipeline.cjs
// can never diverge on which degenerate reasoning shapes they handle.
const { stripThinkBlocks } = require('./textUtils.cjs');

// Whisper occasionally emits bracketed annotations for non-speech audio segments.
// These leak into the cleaned output and look unprofessional; strip them up front so
// neither the local structure rules nor the LLM see them. Pattern is intentionally
// narrow — only well-known fixed annotations, not arbitrary [bracketed] text the user
// may have actually dictated (e.g. "[draft]" in a code reference).
const WHISPER_ARTIFACT_LABELS = [
    'BLANK_AUDIO',
    'silence',
    'Silence',
    'Music',
    'music',
    'Applause',
    'applause',
    'Laughter',
    'laughter',
    'Crickets chirping',
    'Subtitle',
    'Subtitles',
    'Caption',
    'Captions',
];
const WHISPER_ARTIFACTS_PATTERN = new RegExp(
    `\\s*\\[(?:${WHISPER_ARTIFACT_LABELS.join('|')})\\]\\s*`,
    'g'
);
const stripWhisperArtifacts = (text) => String(text || '')
    .replace(WHISPER_ARTIFACTS_PATTERN, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

const stripCodeFence = (text) => {
    const raw = String(text || '').trim();
    const fence = raw.match(/^```(?:json|text|markdown)?\s*([\s\S]*?)\s*```$/i);
    return fence ? fence[1].trim() : raw;
};

const sanitizeEditSummary = (summary, fallback = 'final cleanup') => {
    const text = String(summary || '').replace(/\s+/g, ' ').trim();
    if (!text) return fallback;
    if (text.length <= 160) return text;
    return `${text.slice(0, 157).trim()}...`;
};

const parseFinalCleanupOutput = (output) => {
    const rawOutput = stripCodeFence(stripThinkBlocks(output));
    if (!rawOutput) {
        throw new Error('Final cleanup returned empty output');
    }

    try {
        const parsed = extractJson(rawOutput);
        if (typeof parsed.text === 'string') {
            return {
                text: parsed.text,
                editSummary: sanitizeEditSummary(parsed.editSummary, 'tiny final cleanup json'),
                responseFormat: 'json',
            };
        }
    } catch (err) {
        console.warn(`[final-cleanup] tiny helper output was not JSON; using plain text output: ${err.message}`);
    }

    return {
        text: rawOutput,
        editSummary: sanitizeEditSummary(null, 'tiny final cleanup plain text'),
        responseFormat: 'plain-text',
    };
};

const warmup = async () => enqueue(async () => {
    await ensureServer();
    scheduleIdleKill();
    return getStatus();
});

const clean = async (state) => {
    if (_busy) {
        throw new Error('live helper busy');
    }
    _busy = true;

    return enqueue(async () => {
    try {
        clearIdleKillTimer();
        await ensureServer();

        const messages = [
            {
                role: 'system',
                content:
                    'You are Quilly live dictation cleanup. Return strict JSON only. ' +
                    'Clean the visible draft conservatively for live dictation preview. ' +
                    'Fix obvious speech-to-text wording, grammar, casing, punctuation, repeated phrases, and self-corrections only when high confidence. ' +
                    'If unsure, leave wording unchanged. Preserve instructions in instructionBuffer. ' +
                    'Do not invent content. Do not remove user intent commands from instructionBuffer. ' +
                    'The JSON shape is {"visibleDraft":"...","instructionBuffer":"...","stableUntilMs":0,"editSummary":"..."}.',
            },
            {
                role: 'user',
                content: JSON.stringify({
                    rawTranscript: state.rawTranscript || '',
                    visibleDraft: state.visibleDraft || '',
                    instructionBuffer: state.instructionBuffer || '',
                    stableUntilMs: state.stableUntilMs || 0,
                }),
            },
        ];

        const output = await postInference(messages, 0.1);
        const parsed = extractJson(output);

        if (typeof parsed.visibleDraft !== 'string') {
            throw new Error('Live cleanup JSON missing visibleDraft');
        }

        return {
            visibleDraft: parsed.visibleDraft,
            instructionBuffer: typeof parsed.instructionBuffer === 'string'
                ? parsed.instructionBuffer
                : state.instructionBuffer,
            stableUntilMs: Number.isFinite(parsed.stableUntilMs)
                ? parsed.stableUntilMs
                : state.stableUntilMs,
            editSummary: typeof parsed.editSummary === 'string'
                ? parsed.editSummary
                : 'tiny helper cleanup',
        };
    } finally {
        _busy = false;
        scheduleIdleKill();
    }
    });
};

const normalizeFinalWhitespace = (text) =>
    String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

const escapeRegExp = (text) => String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const phraseToPattern = (phrase) =>
    String(phrase || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(escapeRegExp)
        .join('\\s+');

const buildPhraseAlternation = (phrases) =>
    (Array.isArray(phrases) ? phrases : [])
        .map(phraseToPattern)
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)
        .join('|');

const preserveReplacementCase = (replacement, match) => {
    if (!replacement) return replacement;
    if (match === match.toUpperCase() && /[A-Z]/.test(match)) {
        return replacement.toUpperCase();
    }
    if (match[0] === match[0].toUpperCase()) {
        return replacement.charAt(0).toUpperCase() + replacement.slice(1);
    }
    return replacement;
};

const applyCustomReplacements = (text, replacements = []) => {
    let result = String(text || '');
    for (const replacement of replacements) {
        const fromPattern = phraseToPattern(replacement?.from);
        const to = String(replacement?.to || '').trim();
        if (!fromPattern || !to) continue;

        const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])(${fromPattern})(?=$|[^\\p{L}\\p{N}_])`, 'giu');
        result = result.replace(pattern, (match, prefix, found) => (
            `${prefix}${preserveReplacementCase(to, found)}`
        ));
    }
    return result;
};

const insertPhraseBreaks = (text, cues = []) => {
    const alternation = buildPhraseAlternation(cues);
    if (!alternation) return text;

    const pattern = new RegExp(`\\s+(?=(?:${alternation})(?=$|[\\s,.;:!?]))`, 'giu');
    return String(text || '').replace(pattern, '\n\n');
};

const insertNumberedBreaks = (text) => {
    const markerPattern = /(^|[\s,;:])((?:0\.[1-9][0-9]?|[1-9][0-9]?[.)]))\s+(?=[\p{L}"'([])/gu;
    const matches = [...String(text || '').matchAll(markerPattern)];
    if (matches.length < 2) return text;

    return text.replace(markerPattern, (match, prefix, marker, offset) => {
        const normalizedMarker = marker.startsWith('0.') ? `${marker.slice(2)}.` : marker;
        return `${offset === 0 ? '' : '\n\n'}${normalizedMarker} `;
    });
};

const NUMBER_WORDS = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
};

const insertSpokenPointBreaks = (text, cues = []) => {
    const source = String(text || '');
    const cueAlternation = buildPhraseAlternation(cues);
    if (!cueAlternation) return source;

    let matchCount = 0;
    const pattern = new RegExp(
        `(^|[\\s,;:])(?:${cueAlternation})\\s+(one|two|three|four|five|six|seven|eight|nine|ten|\\d{1,2})\\b[,.]?\\s*`,
        'giu'
    );
    const replaced = source.replace(
        pattern,
        (match, prefix, value, offset) => {
            const number = NUMBER_WORDS[value.toLowerCase()] || value;
            matchCount++;
            return `${offset === 0 ? '' : '\n\n'}${number}. `;
        }
    );

    return matchCount >= 1 ? replaced : source;
};

const insertStandaloneNumberWordBreaks = (text) => {
    const source = String(text || '');
    const markerPattern = /(^|[.!?]\s+|\n\n)(Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten),?\s+/g;
    const matches = [...source.matchAll(markerPattern)];
    if (matches.length === 0 && !/\n\n1\.\s/.test(source)) return source;

    return source.replace(markerPattern, (match, prefix, value, offset) => {
        const number = NUMBER_WORDS[value.toLowerCase()];
        const boundary = /[.!?]/.test(prefix) ? prefix.trimEnd() : '';
        const spacer = offset === 0 ? '' : boundary ? `${boundary}\n\n` : '\n\n';
        return `${spacer}${number}. `;
    });
};

const insertOrdinalBreaks = (text) => {
    const source = String(text || '');
    const markerPattern = /(^|[\s,;:])((?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)(?:\s+point)?)\b[,.]?\s+/gi;
    const matches = [...source.matchAll(markerPattern)];
    if (matches.length < 2) return source;

    return source.replace(markerPattern, (match, prefix, marker, offset) => {
        const cleanMarker = marker.replace(/\s+point$/i, '');
        return `${offset === 0 ? '' : '\n\n'}${cleanMarker.charAt(0).toUpperCase()}${cleanMarker.slice(1)}, `;
    });
};

const groupLongParagraphs = (text) => {
    const paragraphs = String(text || '').split(/\n{2,}/);
    return paragraphs.map((paragraph) => {
        const trimmed = paragraph.trim();
        if (trimmed.length < 700 || trimmed.includes('\n')) return trimmed;

        const sentences = trimmed.split(/(?<=[.!?])\s+/).filter(Boolean);
        if (sentences.length < 6) return trimmed;

        const groups = [];
        for (let i = 0; i < sentences.length; i += 3) {
            groups.push(sentences.slice(i, i + 3).join(' '));
        }
        return groups.join('\n\n');
    }).filter(Boolean).join('\n\n');
};

const applyFinalStructureRules = (text, rules = {}) => {
    const options = sanitizeLocalStructureRules(rules);
    let result = normalizeFinalWhitespace(text);
    if (!result) return '';
    if (!options.enabled) return result;

    if (options.customReplacements.length > 0) {
        result = applyCustomReplacements(result, options.customReplacements);
    }
    if (options.phraseBreaks) {
        result = insertPhraseBreaks(result, options.phraseBreakCues);
    }
    if (options.spokenPointBreaks) {
        result = insertSpokenPointBreaks(result, options.numberedPointCues);
    }
    if (options.standaloneNumberBreaks) {
        result = insertStandaloneNumberWordBreaks(result);
    }
    if (options.decimalNumberBreaks) {
        result = insertNumberedBreaks(result);
    }
    if (options.ordinalBreaks && !/\n\n\d+\.\s/.test(result)) {
        result = insertOrdinalBreaks(result);
    }
    if (options.groupLongParagraphs) {
        result = groupLongParagraphs(result);
    }

    return normalizeFinalWhitespace(result);
};

const cleanupFinalText = async ({ text, structuredDraft = null, systemPrompt = null, localStructureRules = null } = {}) => {
    const originalText = String(text || '').trim();
    if (!originalText) {
        return { text: '', editSummary: 'empty' };
    }
    if (_busy) {
        throw new Error('tiny cleanup helper busy');
    }
    _busy = true;

    return enqueue(async () => {
    try {
        clearIdleKillTimer();
        await ensureServer();

        const prompt = typeof systemPrompt === 'string' && systemPrompt.trim()
            ? systemPrompt.trim()
            : DEFAULT_FINAL_CLEANUP_PROMPT;
        const userPayload = structuredDraft && structuredDraft !== originalText
            ? JSON.stringify({ rawText: originalText, locallyStructuredDraft: structuredDraft })
            : JSON.stringify({ rawText: originalText });

        const messages = [
            {
                role: 'system',
                // /no_think disables Qwen3 reasoning. Qwen3.5 (the tiny helper) ignores
                // the unknown directive but it keeps both code paths symmetric.
                content: `${prompt}\n\n/no_think`,
            },
            {
                role: 'user',
                content: userPayload,
            },
        ];

        console.log('\n[final-cleanup][tiny helper system prompt]');
        console.log(messages[0].content);
        console.log('[final-cleanup][end tiny helper system prompt]\n');
        console.log('[final-cleanup][tiny helper user input]');
        console.log(messages[1].content);
        console.log('[final-cleanup][end tiny helper user input]\n');

        // Tight cap: faithful cleanup should not grow the text. ~15% headroom over input
        // tokens (chars/3.5) plus 80 for JSON overhead. Hard ceiling at 1024 stops runaway
        // rewrites; floor at 256 keeps short inputs complete.
        const maxTokens = Math.min(1024, Math.max(256, Math.ceil(originalText.length / 3.5) + 80));
        const output = await postInference(messages, 0.1, maxTokens);
        console.log('[final-cleanup][tiny helper raw output]');
        console.log(output);
        console.log('[final-cleanup][end tiny helper raw output]\n');

        const parsed = parseFinalCleanupOutput(output);

        const cleanedText = applyFinalStructureRules(parsed.text, localStructureRules);
        if (!cleanedText) {
            throw new Error('Final cleanup returned empty text');
        }

        const originalWords = originalText.split(/\s+/).filter(Boolean).length;
        const cleanedWords = cleanedText.split(/\s+/).filter(Boolean).length;
        const hasJsonArtifacts = /"text"|"editSummary"|^\s*[{[]/.test(cleanedText);
        const hasAssistantDisclaimer = /\b(?:as an ai|i cannot|i can't|sorry,? but)\b/i.test(cleanedText);

        if (hasJsonArtifacts || hasAssistantDisclaimer) {
            throw new Error('Final cleanup output looked suspicious');
        }
        if (originalWords >= 8 && cleanedWords < Math.ceil(originalWords * 0.55)) {
            throw new Error('Final cleanup removed too much text');
        }

        return {
            text: cleanedText,
            editSummary: sanitizeEditSummary(parsed.editSummary, 'tiny final cleanup'),
            responseFormat: parsed.responseFormat,
            modelId: LIVE_MODEL_ID,
        };
    } finally {
        _busy = false;
        scheduleIdleKill();
    }
    });
};

module.exports = {
    LIVE_MODEL_ID,
    getStatus,
    setGpuMode,
    warmup,
    clean,
    cleanupFinalText,
    structureFinalText: applyFinalStructureRules,
    stripWhisperArtifacts,
    kill,
    _internal: {
        extractJson,
        parseFinalCleanupOutput,
        sanitizeEditSummary,
        stripThinkBlocks,
        stripWhisperArtifacts,
        getModelPath,
        isModelInstalled,
        getNGpuLayers,
        ensureServer,
        applyFinalStructureRules,
        applyCustomReplacements,
        insertPhraseBreaks,
        insertSpokenPointBreaks,
    },
};
