'use strict';

// llamaService.cjs — llama-server subprocess lifecycle manager
//
// Manages a long-lived llama-server.exe child process communicating via
// OpenAI-compatible HTTP API on localhost:8787.
//
// Public API:
//   infer(intent, messages, temperature) — route intent, ensure correct model loaded, run inference
//   spawn(modelPath, port, nGpuLayers)   — spawn llama-server (also used internally by ensureServer)
//   kill()                               — force-kill via taskkill and confirm death
//   isRunning()                          — true if child process reference is held
//   events                               — EventEmitter: 'spawning', 'ready', 'error', 'killed', 'cpu-fallback'
//   cleanupZombie()                      — kill stale PID from previous crash at startup
//   setWhisperPid(pid)                   — inform service of running Whisper PID for VRAM swap
//
// Internal API (exposed via _internal for testing):
//   pollHealth, postInference, isPidAlive, waitForDeath, writePid, deletePid,
//   selectModel, ensureServer, enqueue, ensureWhisperUnloaded, getNGpuLayers, cleanupZombie

const { spawn: nodeSpawn, execFile } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { EventEmitter } = require('events');
const llamaDownloader = require('./llamaDownloader.cjs');

// ─── Module State ─────────────────────────────────────────────────────────────

/** @type {import('child_process').ChildProcess|null} */
let _proc = null;

/** @type {string|null} Currently loaded model key (e.g. 'qwen3.5-9b') — null if no server running or health not yet confirmed */
let _currentModel = null;

/** @type {string} User model preference: 'auto', '4b', or '9b' */
let _modelPreference = 'auto';

/** @type {'auto'|'gpu'|'cpu'} User inference device preference */
let _gpuMode = 'auto';

/** @type {number|null} PID of the currently running Whisper process, set by setWhisperPid() */
let _whisperPid = null;

/** @type {boolean} True if last spawn fell back to CPU due to GPU OOM */
let _isCpuFallback = false;

/** Fixed port for llama-server */
const PORT = 8787;

/** Module-level EventEmitter for lifecycle events */
const events = new EventEmitter();

let _releaseHoldCount = 0;
let _releasePending = false;

// ─── PID File Helpers ─────────────────────────────────────────────────────────

/**
 * Resolve PID file path from Electron userData.
 * @returns {string}
 */
const getPidFilePath = () =>
    path.join(app.getPath('userData'), 'llama', 'llama-server.pid');

/**
 * Write the server PID to the PID file.
 * Creates parent directory if it does not exist.
 * @param {number} pid
 */
const writePid = (pid) => {
    const pidFile = getPidFilePath();
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, String(pid), 'utf8');
};

/**
 * Delete the PID file.
 * Swallows ENOENT — safe to call even if file was never created.
 */
const deletePid = () => {
    const pidFile = getPidFilePath();
    try {
        fs.unlinkSync(pidFile);
    } catch (err) {
        if (err.code !== 'ENOENT') {
            throw err;
        }
    }
};

// ─── Process Status Helpers ───────────────────────────────────────────────────

/**
 * Check if a PID is alive using tasklist (Windows built-in).
 * Uses execFile (not exec) to avoid shell injection.
 *
 * @param {number} pid
 * @returns {Promise<boolean>} true if process is running, false otherwise
 */
const isPidAlive = (pid) =>
    new Promise((resolve) => {
        if (!pid || pid <= 0) {
            resolve(false);
            return;
        }
        execFile(
            'tasklist',
            ['/FI', `PID eq ${pid}`, '/NH'],
            { windowsHide: true },
            (err, stdout) => {
                if (err) {
                    resolve(false);
                    return;
                }
                // tasklist output includes the PID string if the process is alive
                resolve(stdout.includes(String(pid)));
            }
        );
    });

/**
 * Poll tasklist until the PID is confirmed dead, or timeout expires.
 *
 * @param {number} pid
 * @param {number} [timeoutMs=10000]
 * @param {number} [intervalMs=200]
 * @returns {Promise<void>}
 */
const waitForDeath = (pid, timeoutMs = 10000, intervalMs = 200) =>
    new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;

        const check = async () => {
            const alive = await isPidAlive(pid);
            if (!alive) {
                resolve();
                return;
            }
            if (Date.now() >= deadline) {
                reject(
                    new Error(`PID ${pid} did not die within ${timeoutMs}ms`)
                );
                return;
            }
            setTimeout(check, intervalMs);
        };

        check();
    });

// ─── Health Check ─────────────────────────────────────────────────────────────

/**
 * Poll GET http://localhost:{port}/health until the server reports ready.
 *
 * Resolution:
 *   200 → resolves, emits 'ready'
 *   500 → rejects with Error('llama-server failed to load model')
 *   503 → retries (model still loading)
 *   ECONNREFUSED / other errors → retries
 *   deadline exceeded → rejects with Error('llama-server health timeout')
 *
 * @param {number} port
 * @param {number} [timeoutMs=30000]
 * @param {number} [intervalMs=300]
 * @returns {Promise<void>}
 */
const pollHealth = (port, timeoutMs = 30000, intervalMs = 300, abortSignal = null) =>
    new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        let activeReq = null;
        const deadline = Date.now() + timeoutMs;

        const cleanup = () => {
            settled = true;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (activeReq) {
                activeReq.destroy();
                activeReq = null;
            }
            if (abortSignal) {
                abortSignal.removeEventListener('abort', onAbort);
            }
        };

        const finish = (fn, value) => {
            if (settled) return;
            cleanup();
            fn(value);
        };

        const onAbort = () => {
            const reason = abortSignal?.reason instanceof Error
                ? abortSignal.reason
                : new Error('llama-server health check aborted');
            finish(reject, reason);
        };

        if (abortSignal) {
            if (abortSignal.aborted) {
                onAbort();
                return;
            }
            abortSignal.addEventListener('abort', onAbort, { once: true });
        }

        const scheduleCheck = () => {
            if (settled) return;
            timer = setTimeout(check, intervalMs);
        };

        const check = () => {
            if (settled) return;
            if (Date.now() >= deadline) {
                finish(reject, new Error('llama-server health timeout'));
                return;
            }

            const req = http.get(
                `http://localhost:${port}/health`,
                (res) => {
                    activeReq = null;
                    // Drain response body to free the socket
                    let body = '';
                    res.on('data', (chunk) => { body += chunk; });
                    res.on('end', () => {
                        if (settled) return;
                        if (res.statusCode === 200) {
                            events.emit('ready');
                            finish(resolve);
                        } else if (res.statusCode === 500) {
                            finish(reject, new Error('llama-server failed to load model'));
                        } else {
                            // 503 = loading; any other code — retry
                            scheduleCheck();
                        }
                    });
                }
            );
            activeReq = req;

            req.on('error', () => {
                activeReq = null;
                if (settled) return;
                // ECONNREFUSED or other network error — retry
                scheduleCheck();
            });

            req.end();
        };

        check();
    });

/**
 * Wait for health, but fail immediately if the spawned process errors or exits.
 *
 * Without this guard, a missing binary can make ensureServer wait for the full
 * health timeout even though the child process has already failed.
 */
const waitForHealthOrExit = (proc, port, timeoutMs = 30000, intervalMs = 300) =>
    new Promise((resolve, reject) => {
        const controller = new AbortController();

        const cleanup = () => {
            proc.removeListener('error', onError);
            proc.removeListener('close', onClose);
        };

        const fail = (err) => {
            cleanup();
            controller.abort(err);
            reject(err);
        };

        const onError = (err) => fail(err);
        const onClose = (code) => fail(new Error(`llama-server exited before ready (code ${code})`));

        proc.once('error', onError);
        proc.once('close', onClose);

        pollHealth(port, timeoutMs, intervalMs, controller.signal)
            .then(() => {
                cleanup();
                resolve();
            })
            .catch((err) => {
                cleanup();
                reject(err);
            });
    });

// ─── Inference ────────────────────────────────────────────────────────────────

/**
 * POST to /v1/chat/completions and return the response content string.
 *
 * @param {number} port
 * @param {Array<{role: string, content: string}>} messages
 * @param {number} temperature
 * @returns {Promise<string>}
 */
const postInference = (port, messages, temperature) =>
    new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify({ messages, temperature, stream: false });
        const options = {
            hostname: 'localhost',
            port,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr),
            },
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let parsed;
                try {
                    parsed = JSON.parse(data);
                } catch (e) {
                    reject(new Error(`Bad inference response: ${e.message}`));
                    return;
                }

                if (
                    !parsed.choices ||
                    !Array.isArray(parsed.choices) ||
                    parsed.choices.length === 0 ||
                    !parsed.choices[0].message
                ) {
                    reject(
                        new Error(
                            'Invalid inference response: missing choices[0].message'
                        )
                    );
                    return;
                }

                resolve(parsed.choices[0].message.content);
            });
        });

        req.on('error', (err) => {
            reject(new Error(`Inference request failed: ${err.message}`));
        });

        req.write(bodyStr);
        req.end();
    });

// ─── Kill Server ──────────────────────────────────────────────────────────────

/**
 * Force-kill llama-server via taskkill /F /PID, wait for death confirmation,
 * clean up PID file and internal state.
 *
 * Resolves immediately if no process is currently running.
 * After successful kill, emits 'killed' (unless proc.on('close') already did).
 *
 * @returns {Promise<void>}
 */
const killServer = async () => {
    _releasePending = false;

    if (!_proc) {
        return;
    }

    const pid = _proc.pid;

    // Detach our reference before async work to prevent re-entry
    const proc = _proc;
    _proc = null;
    _currentModel = null;

    try {
        // taskkill /F /PID — force kill, ignore exit code (process may already be dead)
        await new Promise((resolve) => {
            execFile(
                'taskkill',
                ['/F', '/PID', String(pid)],
                { windowsHide: true },
                () => resolve()  // always resolve — exit 1 means "already dead"
            );
        });

        // Poll until PID is confirmed absent from tasklist
        await waitForDeath(pid, 10000, 200);
    } catch (killErr) {
        console.error(`[llamaService] Warning: kill confirmation failed: ${killErr.message}`);
    }

    deletePid();

    // Emit 'killed' — consumers should be idempotent.
    // The close handler may also emit 'killed' if the OS closes the process
    // before our taskkill call clears _proc. That is acceptable.
    events.emit('killed');

    console.log(`[llamaService] Server killed (PID ${pid})`);
};

const holdServer = () => {
    _releaseHoldCount++;
    let released = false;

    return async () => {
        if (released) return;
        released = true;
        _releaseHoldCount = Math.max(0, _releaseHoldCount - 1);

        if (_releaseHoldCount === 0 && _releasePending) {
            _releasePending = false;
            await killServer();
        }
    };
};

const releaseServerAfterResult = async () => {
    if (_releaseHoldCount > 0) {
        _releasePending = true;
        return;
    }

    await killServer();
};

// ─── Spawn Server ─────────────────────────────────────────────────────────────

/**
 * Spawn llama-server.exe with the given model, port, and GPU layer count.
 *
 * - Sets cwd to binary directory for CUDA DLL co-location
 * - Sets windowsHide: true so no console window appears
 * - Writes PID file after successful spawn
 * - Attaches close handler that resets internal state and emits 'killed'
 * - Attaches stderr collector for OOM/crash diagnostics (logged, not parsed)
 * - Emits 'spawning' before spawn
 *
 * @param {string} modelPath - path to .gguf model file
 * @param {number} [port=PORT]
 * @param {number} [nGpuLayers=999]
 * @returns {import('child_process').ChildProcess}
 */
const spawnServer = (modelPath, port = PORT, nGpuLayers = 999) => {
    const binaryPath = llamaDownloader.findBinary();
    if (!binaryPath) {
        const err = new Error(
            'llama-server binary not found. Download it first via llamaDownloader.downloadBinary()'
        );
        events.emit('error', err);
        throw err;
    }

    const args = [
        '--model', modelPath,
        '--port', String(port),
        '--host', '127.0.0.1',
        '--n-gpu-layers', String(nGpuLayers),
        '--ctx-size', '4096',
        '--parallel', '1',
    ];

    events.emit('spawning');

    const proc = nodeSpawn(binaryPath, args, {
        cwd: path.dirname(binaryPath),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    _proc = proc;
    // NOTE: _currentModel is NOT set here. It is set by ensureServer() only after
    // pollHealth() succeeds (Pitfall 3 from RESEARCH.md). Setting it here would
    // cause race conditions where infer() thinks the model is ready before it is.

    // Write PID file for zombie cleanup on next startup
    writePid(proc.pid);

    console.log(
        `[llamaService] Spawned llama-server PID=${proc.pid} model=${path.basename(modelPath)} port=${port} nGpuLayers=${nGpuLayers}`
    );

    // Collect stderr for OOM/crash diagnostics — log, do not parse for control flow
    let stderrBuffer = '';
    proc.stderr.on('data', (chunk) => {
        stderrBuffer += chunk.toString();
        // Trim buffer to avoid unbounded memory growth
        if (stderrBuffer.length > 8192) {
            stderrBuffer = stderrBuffer.slice(-4096);
        }
        console.error(`[llamaService stderr] ${chunk.toString().trim()}`);
    });

    // Close handler: authoritative "process died" signal
    proc.on('close', (code) => {
        if (_proc === proc) {
            // We still hold the reference — process died without explicit kill()
            _proc = null;
            _currentModel = null;
        }
        deletePid();
        events.emit('killed', code);
        console.log(`[llamaService] Server process closed with code ${code}`);
        if (stderrBuffer && code !== 0) {
            console.error(`[llamaService] Last stderr: ${stderrBuffer.slice(-1000)}`);
        }
    });

    // Error handler: spawn failure (binary not found, permission denied, etc.)
    proc.on('error', (err) => {
        if (_proc === proc) {
            _proc = null;
            _currentModel = null;
        }
        deletePid();
        events.emit('error', err);
        console.error(`[llamaService] Spawn error: ${err.message}`);
    });

    return proc;
};

// ─── Whisper PID Tracking ─────────────────────────────────────────────────────

/**
 * Store the PID of the currently running Whisper process so that
 * ensureWhisperUnloaded() can wait for it to exit before spawning llama-server.
 *
 * Called by main.cjs (Phase 5) when Whisper starts and exits.
 *
 * @param {number|null} pid
 */
const setWhisperPid = (pid) => {
    _whisperPid = pid;
};

// ─── Whisper VRAM Unload ──────────────────────────────────────────────────────

/**
 * Ensure the Whisper process has exited before spawning llama-server.
 *
 * - If no Whisper PID is tracked: resolves immediately (nothing to unload)
 * - If Whisper PID is set but already dead: clears PID, resolves
 * - If Whisper PID is set and alive: waits up to 10s for natural death
 * - If still alive after 10s: force-kills via taskkill /F, then confirms death
 *
 * Per CONTEXT.md: "Silent swap — no user notification during Whisper -> LLM transitions"
 *
 * @returns {Promise<void>}
 */
const ensureWhisperUnloaded = async () => {
    if (_whisperPid === null) {
        return;
    }

    const pid = _whisperPid;

    // Check if already dead before waiting
    const alive = await isPidAlive(pid);
    if (!alive) {
        _whisperPid = null;
        return;
    }

    console.log(`[llamaService] Waiting for Whisper PID ${pid} to exit...`);

    try {
        await waitForDeath(pid, 10000, 200);
    } catch (_timeoutErr) {
        // Whisper didn't exit naturally — force kill
        console.log(`[llamaService] Force-killing Whisper PID ${pid}`);
        await new Promise((resolve) => {
            execFile(
                'taskkill',
                ['/F', '/PID', String(pid)],
                { windowsHide: true },
                () => resolve()  // always resolve — exit 1 means "already dead"
            );
        });
        // Confirm death after force kill (shorter timeout — taskkill /F is authoritative)
        await waitForDeath(pid, 5000, 200);
    }

    _whisperPid = null;
};

// ─── GPU Layers ───────────────────────────────────────────────────────────────

/**
 * Return the number of GPU layers to use for llama-server.
 *
 * Uses gpuDetector.detectGpu() and the user GPU mode to choose CUDA layers:
 *   - cpu: return 0
 *   - auto + CUDA: return 999
 *   - auto without CUDA: return 0
 *   - gpu without CUDA: throw so the caller sees GPU mode is unavailable
 *
 * gpuDetector is required lazily inside this function to avoid circular
 * dependency at module load time.
 *
 * If detectGpu throws: log error, return 0 (safe CPU fallback).
 *
 * @returns {Promise<number>}
 */
const getNGpuLayers = async () => {
    if (_gpuMode === 'cpu') {
        return 0;
    }

    try {
        const gpuDetector = require('./gpuDetector.cjs');
        const gpu = await gpuDetector.detectGpu();
        const hasUsableCuda = gpu.recommended === 'cuda12' || gpu.recommended === 'cuda11';
        if (hasUsableCuda) {
            return 999;
        }
        if (_gpuMode === 'gpu') {
            throw new Error('GPU mode requested but no compatible CUDA GPU was detected');
        }
        return 0;
    } catch (err) {
        if (_gpuMode === 'gpu') {
            throw err;
        }
        console.error(`[llamaService] GPU detection failed, defaulting to CPU: ${err.message}`);
        return 0;
    }
};

// ─── Zombie Cleanup ───────────────────────────────────────────────────────────

/**
 * Clean up stale llama-server process from a previous crash.
 *
 * Called at app startup by main.cjs (Phase 5). Safe to call before Electron
 * app is fully ready — does not assume any windows exist.
 *
 * - If PID file does not exist: resolves immediately
 * - If PID file content is NaN: deletes PID file, resolves
 * - If PID is alive: kills via taskkill /F, waits for death, deletes PID file
 * - If PID is already dead: deletes PID file only
 *
 * Per CONTEXT.md: "Silent PID file cleanup at app startup — no user notification"
 *
 * @returns {Promise<void>}
 */
const cleanupZombie = async () => {
    const pidFile = getPidFilePath();

    let pidContent;
    try {
        pidContent = fs.readFileSync(pidFile, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') {
            return; // No PID file — nothing to clean up
        }
        throw err;
    }

    const pid = parseInt(pidContent, 10);

    if (isNaN(pid)) {
        // Corrupted PID file — delete and move on
        deletePid();
        return;
    }

    const alive = await isPidAlive(pid);

    if (alive) {
        console.log(`[llamaService] Killing zombie llama-server PID ${pid}`);
        await new Promise((resolve) => {
            execFile(
                'taskkill',
                ['/F', '/PID', String(pid)],
                { windowsHide: true },
                () => resolve()
            );
        });
        try {
            await waitForDeath(pid, 10000, 200);
        } catch (err) {
            console.error(`[llamaService] Warning: zombie kill confirmation failed: ${err.message}`);
        }
    }

    deletePid();
};

// ─── Model Selection ──────────────────────────────────────────────────────────

/**
 * Select the model based on user preference (auto/4b/9b).
 * Both Qwen 3.5 models handle all intents — model choice is preference-driven, not intent-driven.
 * Auto mode prefers 9B if installed, falls back to 4B.
 *
 * Throws immediately if the model file does not exist on disk —
 * prevents spawn attempts against missing files.
 *
 * @param {string} intent - 'translate' | 'formal' | 'rewrite' | 'analyze' | ...
 * @returns {{ modelKey: string, modelPath: string }}
 * @throws {Error} if model file does not exist on disk
 */
const selectModel = (intent) => {
    let modelKey;
    if (_modelPreference === '4b') {
        modelKey = 'qwen3.5-4b';
    } else if (_modelPreference === '9b') {
        modelKey = 'qwen3.5-9b';
    } else {
        // Auto: prefer 9B if installed, fall back to 4B
        const model9b = llamaDownloader.MODELS['qwen3.5-9b'];
        const path9b = path.join(llamaDownloader.getModelsPath(), model9b.filename);
        modelKey = fs.existsSync(path9b) ? 'qwen3.5-9b' : 'qwen3.5-4b';
    }

    const model = llamaDownloader.MODELS[modelKey];
    const modelPath = path.join(llamaDownloader.getModelsPath(), model.filename);

    if (!fs.existsSync(modelPath)) {
        throw new Error(`Model not downloaded: ${modelKey}`);
    }

    return { modelKey, modelPath };
};

/**
 * Set the user's model preference. Called by main process when settings change.
 * @param {'auto'|'4b'|'9b'} pref
 */
const setModelPreference = (pref) => {
    _modelPreference = pref || 'auto';
};

/**
 * Set the user's GPU mode. Called by main process when settings change.
 * @param {'auto'|'gpu'|'cpu'} mode
 */
const setGpuMode = (mode) => {
    _gpuMode = ['auto', 'gpu', 'cpu'].includes(mode) ? mode : 'auto';
};

const getGpuMode = () => _gpuMode;

// ─── Request Queue ────────────────────────────────────────────────────────────

/** Promise queue — serializes all infer() calls to prevent concurrent spawn/swap */
let _queue = Promise.resolve();

/**
 * Enqueue an async function for sequential execution.
 *
 * Pattern: the queue chain is extended with fn, but the queue's own "tail"
 * swallows fn's rejection so the queue chain stays healthy. The returned
 * promise is the raw `task` — callers receive the real rejection.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
const enqueue = (fn) => {
    const task = _queue.then(fn);
    _queue = task.catch(() => {}); // prevent unhandled rejection on queue chain
    return task;                   // caller gets real result or rejection
};

// ─── Ensure Server ────────────────────────────────────────────────────────────

/**
 * Ensure llama-server is running with the specified model.
 *
 * Cases:
 *   1. No server running (_proc === null): spawn + poll health
 *   2. Server running with correct model (_currentModel === modelKey): return immediately
 *   3. Server running with wrong model: kill + spawn + poll health
 *
 * VRAM swap: If GPU mode (nGpuLayers > 0), awaits ensureWhisperUnloaded() before
 * spawning to prevent VRAM OOM. CPU mode skips this (no VRAM conflict).
 *
 * GPU OOM fallback: If spawn/health fails with GPU mode, kills hung process and
 * retries with nGpuLayers=0 (CPU). Emits 'cpu-fallback' event for UI notification.
 *
 * Sets _currentModel ONLY after pollHealth() succeeds (Pitfall 3).
 * On any error during spawn/health: resets _currentModel = null, re-throws.
 * Does NOT emit 'error' directly — spawnServer already emits on binary/spawn failures.
 *
 * @param {string} modelKey - model registry key (e.g. 'qwen3.5-9b')
 * @param {string} modelPath - absolute path to .gguf model file
 * @returns {Promise<void>}
 */
const ensureServer = async (modelKey, modelPath) => {
    // Case 2: Correct model already loaded — nothing to do
    if (_proc !== null && _currentModel === modelKey) {
        return;
    }

    // Case 3: Wrong model loaded — kill first
    if (_proc !== null && _currentModel !== modelKey) {
        await killServer();
    }

    // Determine GPU vs CPU mode
    const nGpuLayers = await getNGpuLayers();

    // VRAM swap: unload Whisper before spawning in GPU mode
    if (nGpuLayers > 0) {
        await ensureWhisperUnloaded();
    }

    // Case 1 + 3 continued: Spawn the server with GPU mode attempt
    try {
        const proc = spawnServer(modelPath, PORT, nGpuLayers);
        await waitForHealthOrExit(proc, PORT, 30000, 300);
        // Only set _currentModel after health check passes (Pitfall 3)
        _currentModel = modelKey;
    } catch (err) {
        // Reset model tracking — server is in unknown state
        _currentModel = null;

        // GPU OOM fallback: retry once on CPU in auto mode only.
        // Explicit GPU mode should fail loudly instead of silently using CPU.
        if (nGpuLayers > 0 && _gpuMode !== 'gpu') {
            console.log('[llamaService] GPU spawn failed, retrying on CPU...');

            // Kill the hung GPU process before retrying
            await killServer();

            try {
                const proc = spawnServer(modelPath, PORT, 0); // CPU mode
                await waitForHealthOrExit(proc, PORT, 30000, 300);
                _currentModel = modelKey;
                _isCpuFallback = true;
                events.emit('cpu-fallback');
                return;
            } catch (cpuErr) {
                _currentModel = null;
                // Re-throw the CPU error — no more fallback
                throw cpuErr;
            }
        }

        // Already CPU mode or other failure — no more fallback
        // Do NOT emit 'error' here: spawnServer already emits on binary-not-found
        // and proc.on('error') fires for ENOENT/permission errors.
        throw err;
    }
};

// ─── Public infer() API ───────────────────────────────────────────────────────

/**
 * Run inference for the given intent.
 *
 * This is the single function upstream code calls. All spawn/kill/health/swap
 * complexity is hidden behind this call.
 *
 * Steps (inside the queue):
 *   1. selectModel(intent) — map intent to model, verify file exists
 *   2. ensureServer(modelKey, modelPath) — spawn/swap as needed, wait for ready
 *   3. postInference(PORT, messages, temperature) — POST to /v1/chat/completions
 *
 * Crash recovery: If postInference fails after a successful health check
 * (connection error, bad response), the server is killed and respawned once.
 * If the retry also fails, emits 'error' with user-friendly message and re-throws.
 *
 * Concurrent calls serialize through the queue — the second infer() call
 * will wait for the first to complete (including any model swap) before
 * its own model check begins.
 *
 * @param {string} intent - 'translate' | 'formal' | 'rewrite' | 'analyze' | ...
 * @param {Array<{role: string, content: string}>} messages
 * @param {number} temperature
 * @returns {Promise<string>} inference result text
 */
const infer = (intent, messages, temperature) =>
    enqueue(async () => {
        const { modelKey, modelPath } = selectModel(intent);

        try {
            await ensureServer(modelKey, modelPath);

            try {
                return await postInference(PORT, messages, temperature);
            } catch (inferErr) {
                // Inference failed — server may have crashed. Retry once.
                console.error(`[llamaService] Inference failed, retrying after respawn: ${inferErr.message}`);

                await killServer();
                await ensureServer(modelKey, modelPath);

                try {
                    return await postInference(PORT, messages, temperature);
                } catch (retryErr) {
                    const userErr = new Error('LLM processing failed. Please try again.');
                    events.emit('error', userErr);
                    throw userErr;
                }
            }
        } finally {
            await releaseServerAfterResult();
        }
    });

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    // Public API
    infer,
    spawn: spawnServer,
    kill: killServer,
    isRunning: () => _proc !== null,
    events,

    // Phase 3 additions
    cleanupZombie,
    setWhisperPid,
    setModelPreference,
    setGpuMode,
    getGpuMode,
    holdServer,

    // _internal exposes functions for testing
    _internal: {
        pollHealth,
        postInference,
        isPidAlive,
        waitForDeath,
        writePid,
        deletePid,
        selectModel,
        ensureServer,
        enqueue,
        ensureWhisperUnloaded,
        getNGpuLayers,
        releaseServerAfterResult,
        holdServer,
        cleanupZombie,
    },
};
