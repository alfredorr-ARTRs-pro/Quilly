const { app, BrowserWindow, globalShortcut, screen, clipboard, Tray, Menu, nativeImage, Notification, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const AutoLaunch = require('auto-launch');

// LLM pipeline modules
const pipeline = require('./pipeline.cjs');
const modelRegistry = require('./modelRegistry.cjs');
const llamaService = require('./llamaService.cjs');
const llamaDownloader = require('./llamaDownloader.cjs');
// intentRouter is used by pipeline.cjs internally — no longer called directly from main

// ─── Global error handlers — prevent unhandled errors from crashing the process ─
process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] Unhandled promise rejection:', reason);
});

// Disable security warnings in dev only
if (!app.isPackaged) {
    process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
}

// Set app name explicitly (shows as "Quilly" in Task Manager instead of "Electron")
app.setName('Quilly');

// Auto-launch configuration
const autoLauncher = new AutoLaunch({
    name: 'Quilly',
    path: app.getPath('exe'),
});

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        // Someone tried to run a second instance; surface our window so the
        // user gets feedback that the app is already running.
        showMainWindow();
    });
}

// Settings store (loaded async due to ESM)
let settingsStore = null;

const getSettingsStore = async () => {
    if (!settingsStore) {
        const Store = (await import('electron-store')).default;
        settingsStore = new Store({
            name: 'settings',
            defaults: {
                whisperModel: 'Xenova/whisper-small',
                whisperLanguage: 'auto',
                firstRunComplete: false,
                autoLaunch: false,
                whisperCppEnabled: true,
                llmEnabled: true,
                llmGpuMode: 'auto',
                wakeWord: 'quilly',
                hotkeyTranscribe: 'CommandOrControl+Alt+V',
                hotkeyLlm: 'CommandOrControl+Alt+P',
            }
        });
    }
    return settingsStore;
};

// Available Whisper models (ggmlName used by whisper.cpp, ggmlSize is the GGML file size)
const AVAILABLE_WHISPER_MODELS = [
    { id: 'Xenova/whisper-tiny.en', name: 'Tiny (English)', size: '~39MB', ggmlName: 'ggml-tiny.en.bin', ggmlSize: '~75MB', description: 'Fastest, English only' },
    { id: 'Xenova/whisper-base', name: 'Base', size: '~74MB', ggmlName: 'ggml-base.bin', ggmlSize: '~142MB', description: 'Fast, multilingual' },
    { id: 'Xenova/whisper-small', name: 'Small (Recommended)', size: '~244MB', ggmlName: 'ggml-small.bin', ggmlSize: '~466MB', description: 'Best balance of speed, accuracy, and size' },
    { id: 'Xenova/whisper-medium', name: 'Medium', size: '~769MB', ggmlName: 'ggml-medium.bin', ggmlSize: '~1.5GB', description: 'Higher accuracy, larger download' },
    { id: 'Xenova/whisper-large-v3', name: 'Large v3', size: '~1.5GB', ggmlName: 'ggml-large-v3.bin', ggmlSize: '~3.1GB', description: 'Highest accuracy' },
];

// App windows
let mainWindow = null;
let indicatorWindow = null;
let reviewPopupWindow = null;
let tray = null;

const INDICATOR_BASE_SIZE = { width: 120, height: 48 };
const INDICATOR_CHAIN_SIZE = { width: 260, height: 48 };
const INDICATOR_FIRST_USE_SIZE = { width: 380, height: 70 };

// Recording state
let isRecording = false;
let isBusy = false;  // true while processing/done phase is active
let _busyWatchdog = null;  // safety timer to reset isBusy if transcription-complete never fires
let isStarting = false;
let isStopping = false;

// CLIP-01: Clipboard text captured on hotkey press, passed to processRecording
// Persists for the duration of the recording session; reset after recording completes.
let pendingClipboardText = '';

// LLM mode flag — set by stopRecording() when LLM hotkey is used to stop recording.
// Read by transcription-complete handler to bypass wake word detection.
let pendingLlmMode = false;

// OUT-02: Pending paste text for review-first mode.
// When reviewFirstMode is enabled and LLM ran, paste is deferred until user clicks Accept.
// Cleared after accept (paste executes) or dismiss (user rejected).
let pendingReviewPasteText = null;

// OUT-02: Pending history data for review-first mode.
// Stored when shouldBlockPaste — deferred until popup outcome is known.
// Accepted → normal history entry; dismissed/timed_out → ghost entry.
let pendingHistoryData = null;

// ─── LLM Download Queue State ────────────────────────────────────────────────
// Serializes model downloads — only one at a time (mirrors llamaService.enqueue pattern).
let _downloadQueue = Promise.resolve();
const _activeDownloads = new Set();
const _cancelTokens = {};

// Tracks current LLM status for llm:get-server-status responses
let _currentLlmStatus = 'idle';

// VRAM-01/02: Stores the last whisper.cpp subprocess PID so llamaService.setWhisperPid()
// can confirm the Whisper process is dead before spawning the LLM server.
let _lastWhisperCppPid = null;

// Determine if we're in development mode
const isDev = !app.isPackaged;

function isAllowedAppUrl(url) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol === 'file:') return true;
        if (isDev && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) {
            return parsed.port === '9500';
        }
    } catch (_) {
        return false;
    }
    return false;
}

function attachNavigationGuards(win) {
    // Prevent in-app navigation to external URLs.
    win.webContents.on('will-navigate', (event, url) => {
        if (!isAllowedAppUrl(url)) {
            event.preventDefault();
        }
    });

    // External links should open in the user's browser, not inside Quilly.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (isAllowedAppUrl(url)) {
            return { action: 'allow' };
        }
        shell.openExternal(url).catch((err) => {
            console.error('[navigation] Failed to open external URL:', err.message);
        });
        return { action: 'deny' };
    });
}

function setupPermissionHandler() {
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
        const requestingUrl = details?.requestingUrl || webContents.getURL();
        callback(permission === 'media' && isAllowedAppUrl(requestingUrl));
    });
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        icon: isDev
            ? path.join(__dirname, '../public/icon.png')
            : path.join(__dirname, '../dist/icon.png'),
    });

    if (isDev) {
        mainWindow.loadURL('http://localhost:9500');
        // DevTools can be opened manually with Ctrl+Shift+I when needed
    } else {
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    attachNavigationGuards(mainWindow);

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    // Hide on close instead of destroying so tray click can restore the
    // existing window instantly. The real quit flow (tray Quit, app.quit)
    // sets app.isQuitting via 'before-quit' and allows the close through.
    mainWindow.on('close', (event) => {
        if (!app.isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

let cursorTrackingInterval = null;

// Resolves when the indicator window finishes loading its content
let indicatorReadyResolve = null;
let indicatorReady = null;

function setIndicatorContentSize(size) {
    if (indicatorWindow && !indicatorWindow.isDestroyed()) {
        indicatorWindow.setContentSize(size.width, size.height);
    }
}

function createIndicatorWindow() {
    // Create a promise that resolves when the window content is loaded
    indicatorReady = new Promise((resolve) => {
        indicatorReadyResolve = resolve;
    });

    // Small indicator that follows cursor (wider to fit recording timer pill)
    indicatorWindow = new BrowserWindow({
        width: INDICATOR_BASE_SIZE.width,
        height: INDICATOR_BASE_SIZE.height,
        useContentSize: true,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        show: false,
        focusable: false,
        hasShadow: false,
        thickFrame: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    // Load the indicator route
    if (isDev) {
        indicatorWindow.loadURL('http://localhost:9500/#/indicator');
    } else {
        indicatorWindow.loadFile(path.join(__dirname, '../dist/index.html'), { hash: 'indicator' });
    }

    attachNavigationGuards(indicatorWindow);

    // Ignore mouse events - purely visual indicator
    indicatorWindow.setIgnoreMouseEvents(true);

    indicatorWindow.on('closed', () => {
        stopCursorTracking();
        indicatorWindow = null;
        indicatorReady = null;
    });

    indicatorWindow.webContents.on('did-finish-load', () => {
        console.log('Indicator window loaded successfully');
        if (indicatorReadyResolve) {
            indicatorReadyResolve();
            indicatorReadyResolve = null;
        }
        // If the indicator reloads while isBusy (mid-recording/processing),
        // the React state is lost and transcription-complete will never fire.
        // Reset immediately so the user isn't locked out.
        if (isBusy && !isStarting) {
            console.warn('[main] Indicator reloaded while busy — resetting state to prevent lockout');
            hideIndicator();
        }
    });

    indicatorWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
        console.error('Indicator window failed to load:', errorCode, errorDescription);
    });
}

// ─── Review Popup Window ─────────────────────────────────────────────────────

function createReviewPopupWindow() {
    reviewPopupWindow = new BrowserWindow({
        width: 400,
        height: 250,
        frame: false,
        transparent: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        show: false,
        focusable: true,
        hasShadow: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    if (isDev) {
        reviewPopupWindow.loadURL('http://localhost:9500/#/review-popup');
    } else {
        reviewPopupWindow.loadFile(path.join(__dirname, '../dist/index.html'), { hash: 'review-popup' });
    }

    attachNavigationGuards(reviewPopupWindow);

    const thisPopup = reviewPopupWindow;
    reviewPopupWindow.on('closed', () => {
        // Only null if we're still the active popup (prevents race with showReviewPopup)
        if (reviewPopupWindow === thisPopup) {
            reviewPopupWindow = null;
        }
    });
}

async function showReviewPopup(data) {
    // Prevent stacking — close any existing popup first.
    // Null the reference BEFORE calling close() to prevent the 'closed' event
    // handler from nulling a newly created window (race condition).
    if (reviewPopupWindow && !reviewPopupWindow.isDestroyed()) {
        const oldPopup = reviewPopupWindow;
        reviewPopupWindow = null;
        oldPopup.close();
    }

    createReviewPopupWindow();

    // Position near system tray (bottom-right corner)
    const workArea = screen.getPrimaryDisplay().workArea;
    const windowWidth = 400;
    const windowHeight = 280;
    const x = workArea.x + workArea.width - windowWidth - 20;
    const y = workArea.y + workArea.height - windowHeight - 20;
    reviewPopupWindow.setPosition(x, y);

    reviewPopupWindow.webContents.once('did-finish-load', async () => {
        if (!reviewPopupWindow || reviewPopupWindow.isDestroyed()) return;

        // Send data to renderer so it can populate the popup
        safeSend(reviewPopupWindow, 'review-popup:show', data);

        // Show without stealing focus from user's active app
        reviewPopupWindow.showInactive();

        // Auto-size based on content height
        try {
            const contentHeight = await reviewPopupWindow.webContents.executeJavaScript(
                'document.body.scrollHeight'
            );
            if (reviewPopupWindow && !reviewPopupWindow.isDestroyed()) {
                const newHeight = Math.min(contentHeight + 20, 500);
                reviewPopupWindow.setSize(windowWidth, newHeight);
                // Reposition Y to keep bottom edge aligned
                const newY = workArea.y + workArea.height - newHeight - 20;
                reviewPopupWindow.setPosition(x, newY);
            }
        } catch (err) {
            console.error('[showReviewPopup] Auto-size failed (non-fatal):', err.message);
        }
    });
}

/**
 * Safely send an IPC message to a BrowserWindow, guarding against destroyed windows.
 * @param {BrowserWindow|null} win
 * @param {string} channel
 * @param  {...any} args
 */
function safeSend(win, channel, ...args) {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send(channel, ...args);
    }
}

let lastCursorPos = { x: 0, y: 0 };

function updateIndicatorPosition() {
    if (indicatorWindow && indicatorWindow.isVisible()) {
        const cursorPoint = screen.getCursorScreenPoint();

        // Only update if cursor moved
        if (cursorPoint.x !== lastCursorPos.x || cursorPoint.y !== lastCursorPos.y) {
            indicatorWindow.setPosition(cursorPoint.x + 20, cursorPoint.y + 20);
            lastCursorPos = cursorPoint;
        }
    }
}

function startCursorTracking() {
    if (cursorTrackingInterval) return;
    cursorTrackingInterval = setInterval(updateIndicatorPosition, 100); // ~10fps — sufficient for small indicator overlay, reduces CPU contention
}

function stopCursorTracking() {
    if (cursorTrackingInterval) {
        clearInterval(cursorTrackingInterval);
        cursorTrackingInterval = null;
    }
}

async function showIndicator() {
    if (!indicatorWindow) {
        // Should be pre-loaded, but recreate if missing
        createIndicatorWindow();
    }

    // Wait for indicator content to be loaded before showing
    if (indicatorReady) {
        await indicatorReady;
    }

    // Reset the React phase BEFORE the window becomes visible,
    // so stale UI (e.g. green checkmark from a previous recording)
    // is never shown.
    safeSend(indicatorWindow, 'reset-indicator');

    // Defensively reset to baseline size on every show. Previous sessions may
    // have expanded the window (chain-step pill, first-use prompt), and relying
    // on outer window bounds can drift on Windows fractional DPI.
    setIndicatorContentSize(INDICATOR_BASE_SIZE);

    // Position near cursor
    const cursorPoint = screen.getCursorScreenPoint();
    indicatorWindow.setPosition(cursorPoint.x + 20, cursorPoint.y + 20);
    indicatorWindow.showInactive();

    // Start following cursor
    startCursorTracking();
}

function hideIndicator() {
    stopCursorTracking();
    isRecording = false;
    isBusy = false;
    isStarting = false;
    isStopping = false;
    if (_busyWatchdog) { clearTimeout(_busyWatchdog); _busyWatchdog = null; }
    if (indicatorWindow) {
        // Reset indicator to normal size (may have been expanded for first-use prompt)
        setIndicatorContentSize(INDICATOR_BASE_SIZE);
        // Hide — don't destroy.  Keeping the window alive avoids the
        // costly re-creation + React reload on the next recording, which
        // was the main source of mic-start delay.
        safeSend(indicatorWindow, 'reset-indicator');
        indicatorWindow.hide();
    }
}

// toggleRecording removed — dual hotkey handlers in _registerDualHotkeys() now
// handle start/stop with mode selection directly.

async function startRecording() {
    if (isStarting || isRecording) return;

    isStarting = true;
    isBusy = true;

    // CLIP-01: Capture selected text immediately on hotkey press, before user starts speaking,
    // so the selection context is preserved (user may change focus once they begin recording).
    pendingClipboardText = await captureClipboardSelection();
    console.log(`[startRecording] Clipboard captured: ${pendingClipboardText.length} chars`);

    try {
        await showIndicator();

        isRecording = true;
        isStarting = false;
        isBusy = false; // Recording is live; allow stop via hotkey

        safeSend(indicatorWindow, 'start-recording');
        console.log('Sent start-recording to indicator');
        console.log('Recording started');
    } catch (e) {
        console.error('Failed to start recording:', e);
        isStarting = false;
        isRecording = false;
        isBusy = false;
        pendingClipboardText = '';
        hideIndicator();
    }
}

function stopRecording(mode = 'transcribe') {
    if (!isRecording || isStopping) return;

    isStopping = true;

    // Store LLM mode flag for transcription-complete handler
    pendingLlmMode = (mode === 'llm');

    // Get cursor position NOW (where user wants to paste)
    const cursorPoint = screen.getCursorScreenPoint();

    // Tell indicator to stop recording and process
    safeSend(indicatorWindow, 'stop-recording', {
        x: cursorPoint.x,
        y: cursorPoint.y,
        llmMode: pendingLlmMode,
    });

    // Recording is stopped on the renderer side; the indicator remains
    // visible (processing → done) until transcription-complete hides it.
    isRecording = false;
    isStopping = false;
    isBusy = true; // Block new recordings while processing/done phase is active

    // Safety watchdog: if transcription-complete never fires (e.g., indicator window
    // reloaded mid-recording and lost React state), reset isBusy after 90 seconds
    // so the user isn't permanently locked out.
    if (_busyWatchdog) clearTimeout(_busyWatchdog);
    _busyWatchdog = setTimeout(() => {
        if (isBusy) {
            console.warn('[main] Watchdog: isBusy stuck for 90s — force-resetting state');
            hideIndicator();
        }
        _busyWatchdog = null;
    }, 90_000);

    console.log('Recording stopped, will paste at:', cursorPoint);
}

function showMainWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    } else {
        createMainWindow();
    }
}

function createTray() {
    const iconPath = isDev
        ? path.join(__dirname, '../public/icon.png')
        : path.join(__dirname, '../dist/icon.png');

    const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    tray = new Tray(icon);

    const contextMenu = Menu.buildFromTemplate([
        { label: 'Open Dashboard', click: showMainWindow },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
    ]);

    tray.setToolTip('Quilly');
    tray.setContextMenu(contextMenu);

    tray.on('click', showMainWindow);
}

// Track currently registered accelerator strings so we can unregister them on change
let _registeredHotkeys = [];

function registerGlobalShortcuts() {
    getSettingsStore().then(store => {
        const transcribeKey = store.get('hotkeyTranscribe', 'CommandOrControl+Alt+V');
        const llmKey = store.get('hotkeyLlm', 'CommandOrControl+Alt+P');
        _registerDualHotkeys(transcribeKey, llmKey);
    }).catch(err => {
        console.error('[main] Failed to load hotkey settings, using defaults:', err.message);
        _registerDualHotkeys('CommandOrControl+Alt+V', 'CommandOrControl+Alt+P');
    });
}

function reregisterGlobalShortcuts() {
    // Unregister previous hotkeys
    for (const key of _registeredHotkeys) {
        try { globalShortcut.unregister(key); } catch (_) { /* ignore */ }
    }
    _registeredHotkeys = [];
    registerGlobalShortcuts();
}

function _registerDualHotkeys(transcribeKey, llmKey) {
    // Transcribe hotkey: start recording or stop as plain transcription
    const r1 = globalShortcut.register(transcribeKey, () => {
        if (isStarting || isStopping || isBusy) {
            console.log('Toggle ignored — state transition in progress');
            return;
        }
        if (isRecording) {
            stopRecording('transcribe');
        } else {
            startRecording();
        }
    });
    if (r1) {
        _registeredHotkeys.push(transcribeKey);
        console.log(`Global shortcut registered: ${transcribeKey} (transcribe)`);
    } else {
        console.log(`Global shortcut registration failed: ${transcribeKey}`);
    }

    // LLM hotkey: start recording or stop with LLM processing
    const r2 = globalShortcut.register(llmKey, () => {
        if (isStarting || isStopping || isBusy) {
            console.log('Toggle ignored — state transition in progress');
            return;
        }
        if (isRecording) {
            stopRecording('llm');
        } else {
            startRecording();
        }
    });
    if (r2) {
        _registeredHotkeys.push(llmKey);
        console.log(`Global shortcut registered: ${llmKey} (LLM)`);
    } else {
        console.log(`Global shortcut registration failed: ${llmKey}`);
    }
}

// ─── LLM Status Push Helper ───────────────────────────────────────────────────

/**
 * Send LLM status to both mainWindow and indicatorWindow via push event.
 * Guards every send with window existence and webContents not-destroyed checks.
 *
 * @param {'idle'|'loading-model'|'ready'|'processing'} status
 * @param {object} [detail] - optional payload (errorType, modelId, cpuFallback, etc.)
 */
function sendLlmStatus(status, detail = {}) {
    _currentLlmStatus = status;
    const payload = { status, ...detail };
    // Resize indicator window to fit chain step text ("Step 1/2: Translating...")
    if (detail.chainStep != null && indicatorWindow && !indicatorWindow.isDestroyed()) {
        setIndicatorContentSize(INDICATOR_CHAIN_SIZE);
    }
    for (const win of [mainWindow, indicatorWindow]) {
        safeSend(win, 'llm:status', payload);
    }
}

async function shouldUseCudaForLlm(store) {
    const gpuMode = store.get('llmGpuMode', 'auto');
    if (gpuMode === 'cpu') return false;
    if (gpuMode === 'gpu') return true;

    try {
        const gpu = await gpuDetector.detectGpu();
        return gpu?.recommended === 'cuda12' || gpu?.recommended === 'cuda11';
    } catch (err) {
        console.error('[main] GPU detection failed while selecting LLM runtime:', err.message);
        return false;
    }
}

async function ensureLlamaBinaryForMode(store, sender = null, cancelToken = null) {
    const useCuda = await shouldUseCudaForLlm(store);
    if (llamaDownloader.isBinaryCompatibleWithMode?.(useCuda)) {
        return { success: true, alreadyInstalled: true, useCuda };
    }

    const result = await llamaDownloader.downloadBinary((progress) => {
        if (sender && !sender.isDestroyed()) {
            sender.send('llm:download-progress', { modelId: '__binary__', ...progress });
        }
    }, useCuda, cancelToken);

    return { success: true, useCuda, ...result };
}

// App lifecycle
app.whenReady().then(() => {
    // Ensures Windows toast notifications display correctly (even in dev builds)
    app.setAppUserModelId('com.quilly.app');
    setupPermissionHandler();

    createMainWindow();
    // Pre-load indicator window (hidden) to avoid latency on first use
    createIndicatorWindow();
    createTray();
    registerGlobalShortcuts();

    // ─── llamaService event bridge (ONCE at startup — NOT inside handlers) ───
    // CRITICAL: Attaching inside an ipcMain handler would accumulate listeners
    // per recording and cause MaxListenersExceededWarning (research Pitfall 2).
    llamaService.events.on('spawning', () => {
        sendLlmStatus('loading-model');
    });

    llamaService.events.on('ready', () => {
        sendLlmStatus('ready');
    });

    llamaService.events.on('killed', () => {
        sendLlmStatus('idle');
    });

    llamaService.events.on('cpu-fallback', () => {
        sendLlmStatus('loading-model', { cpuFallback: true });
    });

    llamaService.events.on('error', (err) => {
        const msg = err && err.message ? err.message.toLowerCase() : '';
        let errorType = 'crash';
        if (msg.includes('timeout')) errorType = 'timeout';
        else if (msg.includes('oom') || msg.includes('out of memory')) errorType = 'oom';
        sendLlmStatus('idle', { errorType });
    });

    // INFRA-06: Clean up any zombie llama-server from a previous crash at startup
    llamaService.cleanupZombie().catch(err =>
        console.error('[main] Zombie cleanup failed (non-fatal):', err.message)
    );

    // Load model preference from settings on startup
    getSettingsStore().then(store => {
        llamaService.setModelPreference(store.get('llmModelPreference', 'auto'));
        llamaService.setGpuMode(store.get('llmGpuMode', 'auto'));
    }).catch(err => console.error('[main] Failed to load startup settings:', err.message));

    // Ensure llama-server matches the selected GPU mode when LLM is enabled
    // and at least one model exists. Runs in background; no UI block.
    getSettingsStore().then(async (store) => {
        const llmEnabled = store.get('llmEnabled', false);
        if (!llmEnabled) return;

        // Check if at least one model exists (otherwise binary isn't needed yet)
        const modelStatus = modelRegistry.getModelStatus();
        const anyModelInstalled = Object.values(modelStatus).some(m => m.installed);
        if (!anyModelInstalled) return;

        console.log('[main] LLM enabled with model — ensuring llama-server runtime matches GPU mode...');
        try {
            await ensureLlamaBinaryForMode(store);
            console.log('[main] llama-server runtime ready');
        } catch (err) {
            console.error('[main] Binary preparation failed (non-fatal):', err.message);
        }
    }).catch(() => {});

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createMainWindow();
        }
    });
});

// Keep running in system tray when all windows are closed (don't quit)
app.on('window-all-closed', () => { });

// Mark the app as quitting so the mainWindow 'close' handler allows the
// window to actually close instead of hiding it to tray.
app.on('before-quit', () => {
    app.isQuitting = true;
});

app.on('will-quit', async () => {
    globalShortcut.unregisterAll();
    stopCursorTracking();
    try { await llamaService.kill(); } catch (e) { console.error('[quit] llama kill:', e.message); }
    try {
        const whisperService = require('./whisperService.cjs');
        await whisperService.dispose();
    } catch (e) { console.error('[quit] whisper dispose:', e.message); }
});

/**
 * Capture whatever text the user has selected at the moment the hotkey is pressed.
 *
 * CLIP-01: System captures clipboard content when hotkey is pressed.
 * Plain text only — images, files, and rich text are ignored.
 * Uses execFile for security (not shell execution), same pattern as
 * tasklist/taskkill in llamaService.cjs.
 *
 * Flow: clear clipboard → send Ctrl+C → wait 150ms → read plain text.
 * Returns empty string if nothing is selected or on any error.
 */
async function captureClipboardSelection() {
    const { execFile } = require('child_process');

    // Clear clipboard first so we can distinguish fresh selection from stale content
    clipboard.clear();

    try {
        await new Promise((resolve, reject) => {
            execFile(
                'powershell',
                ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^c")'],
                { windowsHide: true },
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });
    } catch (err) {
        console.warn('[captureClipboardSelection] Ctrl+C failed:', err.message);
        return '';
    }

    // Wait 150ms for the OS clipboard to update.
    // If UAT shows misses on slow machines, upgrade to polling (readText every 20ms up to 200ms).
    await new Promise((resolve) => setTimeout(resolve, 150));

    return clipboard.readText('clipboard') || '';
}

// IPC handlers
const { ipcMain } = require('electron');

ipcMain.handle('hide-indicator', () => {
    hideIndicator();
});

ipcMain.handle('review-popup:copy', (event, text) => {
    clipboard.writeText(text);
});

// OUT-02: Unified popup outcome handler — routes accept/dismiss/timeout to history entries
ipcMain.handle('review-popup:outcome', async (event, { reason }) => {
    // reason: 'accepted' | 'dismissed' | 'timed_out'
    const historyData = pendingHistoryData;
    const pasteText = pendingReviewPasteText;
    pendingHistoryData = null;
    pendingReviewPasteText = null;

    if (reason === 'accepted' && pasteText) {
        // Execute deferred paste
        clipboard.writeText(pasteText);
        setTimeout(() => simulatePaste(), 300);
        // Create normal history entry
        if (mainWindow && historyData) {
            safeSend(mainWindow, 'add-recording', {
                name: `Voice Recording ${new Date().toLocaleTimeString()}`,
                duration: historyData.duration || '0:00',
                status: 'transcribed',
                transcription: historyData.processedOutput || historyData.rawText,
                rawTranscription: historyData.rawText,
                processedResult: historyData.processedOutput,
                intentLabels: historyData.intentLabels || [],
                audioPath: historyData.audioPath,
            });
        }
    } else {
        // Ghost entry for dismissed or timed_out
        if (mainWindow && historyData) {
            safeSend(mainWindow, 'add-recording', {
                name: `Voice Recording ${new Date().toLocaleTimeString()}`,
                duration: historyData.duration || '0:00',
                status: 'transcribed',
                transcription: historyData.processedOutput || historyData.rawText,
                rawTranscription: historyData.rawText,
                processedResult: historyData.processedOutput,
                intentLabels: historyData.intentLabels || [],
                audioPath: historyData.audioPath,
                isGhost: true,
                ghostReason: reason, // 'dismissed' or 'timed_out'
            });
        }
    }

    // Close popup window
    if (reviewPopupWindow && !reviewPopupWindow.isDestroyed()) {
        reviewPopupWindow.close();
    }

    return { success: true };
});

ipcMain.handle('transcription-complete', async (event, { text, x, y, audioData, audioPath: ipcAudioPath, editorMode, editorContent, editorInstruction }) => {
    console.log('Transcription complete:', text);

    const capturedClipboard = pendingClipboardText;
    // Reset pendingClipboardText immediately — prevent stale clipboard leaks
    pendingClipboardText = '';

    let textToPaste = text;
    let didRunLlm = false;
    let processedOutput = null;
    let showingFirstUsePrompt = false;
    let capturedIntent = null;
    let intentLabel = null;
    let intentLabels = [];
    let reviewFirstMode = false;
    let chainResults = [];

    // Capture and reset LLM mode flag (set by stopRecording)
    const llmMode = pendingLlmMode;
    pendingLlmMode = false;

    // Editor mode also needs LLM processing — wake word is already in the assembled text
    const shouldRunLlm = llmMode || editorMode;

    try {
        // Step 1: Determine processing mode based on which hotkey stopped the recording
        let routeResult;
        if (llmMode) {
            // LLM hotkey was used — treat full transcript as freeform (no wake word detection)
            routeResult = {
                wakeWordFound: true,
                intent: 'freeform',
                content: text.trim(),
                rawInstruction: text.trim(),
                targetLanguage: null,
            };
            chainResults = [routeResult];
            console.log('[transcription-complete] LLM mode (hotkey) — freeform processing');
        } else if (editorMode && editorContent && editorInstruction) {
            // Editor mode with separated content/instruction — pass instruction as-is
            // to the LLM via freeform. The model can interpret simple or complex
            // instructions directly; keyword matching would lose specificity
            // (e.g., "rewrite as bullet points sorted by date" → generic rewrite).
            routeResult = {
                wakeWordFound: true,
                intent: 'freeform',
                content: editorContent,
                rawInstruction: editorInstruction,
                targetLanguage: null,
            };
            chainResults = [routeResult];
            console.log('[transcription-complete] Editor mode (separated) — passing instruction as-is to LLM');
        } else if (editorMode) {
            // Fallback: editor mode without separated fields — pipeline routes from assembled text
            routeResult = { wakeWordFound: false, intent: null };
            chainResults = [routeResult];
            console.log('[transcription-complete] Editor mode — pipeline will detect intent');
        } else {
            // Transcribe hotkey — plain transcription, no LLM
            routeResult = { wakeWordFound: false, intent: null };
            chainResults = [routeResult];
            console.log('[transcription-complete] Transcribe mode (hotkey) — raw text');
        }
        console.log('[transcription-complete] Whisper text:', JSON.stringify(text));

        if (shouldRunLlm) {
            // Check if LLM processing is enabled
            const llmStore = await getSettingsStore();
            const llmEnabled = llmStore.get('llmEnabled');
            reviewFirstMode = llmStore.get('reviewFirstMode', false);
            if (!llmEnabled) {
                console.log('[transcription-complete] LLM disabled — pasting raw text');
                if (llmMode) {
                    new Notification({
                        title: 'Quilly',
                        body: 'LLM processing is disabled. Enable it in Settings → LLM.',
                    }).show();
                }
                textToPaste = text;
            } else {
            // Step 2a: Model pre-check — verify the preferred model is downloaded
            // Both Qwen 3.5 models handle all intents, so check the one selectModel would pick
            let neededModelKey = null;
            let modelExists = false;
            const pref = llmStore.get('llmModelPreference', 'auto');
            if (pref === '4b') {
                neededModelKey = 'qwen3.5-4b';
            } else if (pref === '9b') {
                neededModelKey = 'qwen3.5-9b';
            } else {
                // Auto: prefer 9B, fall back to 4B
                const path9b = path.join(llamaDownloader.getModelsPath(), llamaDownloader.MODELS['qwen3.5-9b'].filename);
                const path4b = path.join(llamaDownloader.getModelsPath(), llamaDownloader.MODELS['qwen3.5-4b'].filename);
                if (fs.existsSync(path9b)) {
                    neededModelKey = 'qwen3.5-9b';
                    modelExists = true;
                } else if (fs.existsSync(path4b)) {
                    neededModelKey = 'qwen3.5-4b';
                    modelExists = true;
                } else {
                    neededModelKey = 'qwen3.5-9b'; // default to 9B for prompt
                }
            }
            if (!modelExists && neededModelKey) {
                modelExists = fs.existsSync(path.join(llamaDownloader.getModelsPath(), llamaDownloader.MODELS[neededModelKey].filename));
            }

            if (!neededModelKey || !modelExists) {
                // Model is MISSING — paste raw text so user never loses their words (locked decision)
                console.log(`[transcription-complete] Model missing for intent "${routeResult.intent}" — pasting raw text`);

                // UI-03: First-use prompt — show branded guidance if user hasn't seen it yet
                const store = await getSettingsStore();
                const llmFirstUseDismissed = store.get('llmFirstUsePromptDismissed', false);
                if (!llmFirstUseDismissed) {
                    if (indicatorWindow && !indicatorWindow.isDestroyed()) {
                        // Resize indicator window to fit first-use prompt content
                        setIndicatorContentSize(INDICATOR_FIRST_USE_SIZE);
                        // Reposition so the wider window stays near cursor without going off-screen
                        const display = screen.getPrimaryDisplay().workArea;
                        const cursorPos = screen.getCursorScreenPoint();
                        const promptX = Math.min(
                            cursorPos.x + 15,
                            display.x + display.width - INDICATOR_FIRST_USE_SIZE.width - 15
                        );
                        const promptY = Math.max(cursorPos.y - 80, display.y);
                        indicatorWindow.setPosition(promptX, promptY);
                        safeSend(indicatorWindow, 'llm:first-use-prompt', {
                            modelId: neededModelKey,
                            intent: routeResult.intent,
                        });
                        showingFirstUsePrompt = true;
                    }
                }

                sendLlmStatus('idle', { errorType: 'model-missing', modelId: neededModelKey });
                textToPaste = text;
            } else if (_activeDownloads.has(neededModelKey)) {
                // Model is currently downloading — paste raw text
                console.log(`[transcription-complete] Model "${neededModelKey}" is downloading — pasting raw text`);
                sendLlmStatus('idle', { errorType: 'model-downloading', modelId: neededModelKey });
                textToPaste = text;
            } else {
                let binaryReady = true;
                try {
                    await ensureLlamaBinaryForMode(llmStore, event.sender);
                } catch (binaryErr) {
                    binaryReady = false;
                    console.log('[transcription-complete] llama-server runtime unavailable — pasting raw text:', binaryErr.message);
                    sendLlmStatus('idle', { errorType: 'binary-missing' });
                    textToPaste = text;
                    new Notification({
                        title: 'Quilly',
                        body: 'LLM engine is not ready. Open Settings → LLM to download or repair the runtime.',
                    }).show();
                }

                if (binaryReady) {
                // Model is available — run the full LLM pipeline
                sendLlmStatus('processing');
                // VRAM-01/02: inform llamaService of the last Whisper subprocess PID so
                // ensureWhisperUnloaded() can confirm the process is dead before loading LLM.
                if (_lastWhisperCppPid) {
                    llamaService.setWhisperPid(_lastWhisperCppPid);
                }
                try {
                    let result;
                    if (chainResults.length > 1) {
                        // ─── Multi-intent chained path ───────────────────────────────────────
                        // routeChain() returned multiple intents — run them sequentially.
                        // MDL-09 (CONTEXT.md locked): largest model used for entire chain;
                        // selectModel in llamaService already handles user preference — no per-step swap.
                        const stepLabelMap = {
                            translate: 'Translating...',
                            formal: 'Formatting...',
                            professional: 'Formatting...',
                            email: 'Formatting...',
                            report: 'Formatting...',
                            concise: 'Shortening...',
                            grammar: 'Fixing grammar...',
                            rewrite: 'Rewriting...',
                            analyze: 'Analyzing...',
                            freeform: 'Processing...',
                        };
                        const onStepStart = (stepIdx, totalSteps, intent) => {
                            sendLlmStatus('processing', {
                                chainStep: stepIdx + 1,
                                chainTotal: totalSteps,
                                stepLabel: stepLabelMap[intent] || 'Processing...',
                            });
                        };
                        result = await pipeline.processChainedText(text, chainResults, capturedClipboard, { onStepStart });
                        processedOutput = result.output;
                        didRunLlm = true;
                        capturedIntent = result.intent;
                        intentLabels = result.stepLabels;
                        intentLabel = result.stepLabels.join(' + ') || 'Processed';
                        // Analyze in chain: block paste if ANY step is analyze
                        const isAnalyzeInChain = chainResults.some(r => r.intent === 'analyze');
                        if (isAnalyzeInChain) {
                            textToPaste = text;
                        } else {
                            textToPaste = result.output;
                        }
                    } else {
                        // ─── Single-intent path (unchanged behavior) ─────────────────────────
                        if (
                            audioData &&
                            routeResult.intent === 'translate' &&
                            routeResult.targetLanguage &&
                            routeResult.targetLanguage.toLowerCase() === 'english' &&
                            !capturedClipboard
                        ) {
                            const whisperModelId = llmStore.get('whisperModel') || 'Xenova/whisper-small';
                            const storedWhisperLang = llmStore.get('whisperLanguage') || 'auto';
                            const whisperPipelineOptions = { modelId: whisperModelId };
                            if (storedWhisperLang !== 'auto' && !whisperModelId.endsWith('.en')) {
                                whisperPipelineOptions.language = storedWhisperLang;
                            }
                            // PROC-06: use processRecording so Whisper --translate mode is available.
                            // processRecording will re-transcribe via whisperCppService and apply the
                            // translate-to-English guard at Step 4 — no LLM invocation needed.
                            result = await pipeline.processRecording(audioData, capturedClipboard, whisperPipelineOptions);
                        } else {
                            const pipelineOpts = llmMode
                                ? { routeOverride: routeResult }
                                : (editorContent && editorInstruction)
                                    ? { routeOverride: routeResult, editorInstruction }
                                    : {};
                            result = await pipeline.processTranscribedText(text, capturedClipboard, pipelineOpts);
                        }
                        // For editorMode, the pipeline did its own routing — sync routeResult
                        if (editorMode && !llmMode) {
                            routeResult = {
                                wakeWordFound: true,
                                intent: result.intent,
                                targetLanguage: result.targetLanguage || null,
                            };
                        }
                        // Always capture the processed output
                        processedOutput = result.output;
                        didRunLlm = true;
                        capturedIntent = routeResult.intent;
                        // Map intent to human-readable label
                        const intentLabelMap = {
                            translate: `Translated to ${routeResult.targetLanguage || 'unknown'}`,
                            formal: 'Made formal',
                            professional: 'Made professional',
                            email: 'Formatted as email',
                            report: 'Formatted as report',
                            concise: 'Made concise',
                            grammar: 'Fixed grammar',
                            rewrite: 'Rewritten',
                            analyze: 'Analysis',
                            freeform: 'Processed',
                        };
                        intentLabel = intentLabelMap[routeResult.intent] || 'Processed';
                        intentLabels = intentLabel ? [intentLabel] : [];
                        // Analyze intent: do NOT paste processed result — paste raw text instead.
                        // The processed analysis is stored in history via processedOutput.
                        if (routeResult.intent === 'analyze') {
                            textToPaste = text;
                        } else {
                            textToPaste = result.output;
                        }
                    }
                } catch (pipelineErr) {
                    console.error('[transcription-complete] Pipeline failed, pasting raw text:', pipelineErr.message);
                    sendLlmStatus('idle', { errorType: 'crash' });
                    textToPaste = text;
                    didRunLlm = false;
                    processedOutput = null;
                    new Notification({
                        title: 'Quilly',
                        body: 'LLM processing failed. Raw transcription saved to history.'
                    }).show();
                } finally {
                    // VRAM-01/02: clear the Whisper PID reference after pipeline completes or errors.
                    llamaService.setWhisperPid(null);
                    _lastWhisperCppPid = null;
                }
                sendLlmStatus('idle');
                }
            }
            } // end else (llmEnabled)
        }
        // If transcribe mode: textToPaste remains = text (plain transcription path)
    } catch (routeErr) {
        console.error('[transcription-complete] Intent routing failed, pasting raw text:', routeErr.message);
        textToPaste = text;
    }

    // OUT-02: Determine if paste should be blocked pending user review.
    // - Analyze intent: always blocks auto-paste (result is informational, never pasted to cursor)
    //   For chains: block if ANY step is analyze.
    // - reviewFirstMode: blocks auto-paste when LLM ran — user must accept in popup
    // - Plain transcription (didRunLlm===false): never blocked — always paste immediately
    const isAnalyzeIntent = chainResults.length > 1
        ? chainResults.some(r => r.intent === 'analyze')
        : capturedIntent === 'analyze';
    const shouldBlockPaste = didRunLlm && processedOutput && (isAnalyzeIntent || reviewFirstMode);

    console.log('[transcription-complete] Popup decision:', JSON.stringify({ didRunLlm, hasProcessedOutput: !!processedOutput, isAnalyzeIntent, shouldBlockPaste, reviewFirstMode, capturedIntent, intentLabel }));

    // Editor mode: skip all paste/popup/indicator side effects — result is returned via IPC
    // and surfaced in the editor UI (Dashboard history table).
    if (editorMode) {
        console.log('[transcription-complete] Editor mode — skipping paste/popup side effects');
    } else {
        if (shouldBlockPaste) {
            // Do NOT write to clipboard or simulate paste — defer until user accepts (or never for analyze)
            if (!isAnalyzeIntent && reviewFirstMode) {
                // Store deferred paste text (analyze never pastes, so only store for reviewFirst)
                pendingReviewPasteText = textToPaste;
            }
            // Store history data for deferred creation on popup outcome
            // (both analyze and reviewFirst need this — popup outcome handler creates the history entry)
            pendingHistoryData = {
                rawText: text,
                processedOutput,
                intentLabel,
                intentLabels,
                audioPath: ipcAudioPath || null,
            };

            // Show review popup with appropriate mode flags
            showReviewPopup({
                text: processedOutput,
                intentLabel: intentLabel || 'Processed',
                isAnalyze: isAnalyzeIntent,
                isReviewFirst: reviewFirstMode && !isAnalyzeIntent,
            }).catch(err => console.error('[transcription-complete] showReviewPopup failed:', err.message));
        } else {
            // Default mode: write to clipboard and paste immediately
            clipboard.writeText(textToPaste);

            // OUT-03: Show popup as reference (paste already happened) when LLM ran
            if (didRunLlm && processedOutput) {
                showReviewPopup({
                    text: processedOutput,
                    intentLabel: intentLabel || 'Processed',
                    isAnalyze: false,
                    isReviewFirst: false,
                }).catch(err => console.error('[transcription-complete] showReviewPopup failed:', err.message));
            }
        }

        // Hide indicator — but if the first-use prompt is showing, leave the window visible
        // so the user can read the prompt and click "Download now" or dismiss it.
        // The renderer calls hideIndicator() once the user interacts with the prompt.
        if (!showingFirstUsePrompt) {
            hideIndicator();
        }

        // Wait for window focus to return to previous app, then paste
        // Skip paste when blocking — paste is either deferred (reviewFirst) or never (analyze)
        if (!shouldBlockPaste) {
            setTimeout(() => {
                console.log('Attempting to paste...');
                simulatePaste();

                // Immediately afterward, dispose of the Whisper model to free memory
                setTimeout(() => {
                    console.log('Unloading Whisper model from RAM...');
                    whisperService.dispose().catch(e => console.error('Failed to dispose model:', e));
                }, 200);
            }, 300);
        } else {
            // Still dispose Whisper model even when paste is blocked
            setTimeout(() => {
                console.log('Unloading Whisper model from RAM...');
                whisperService.dispose().catch(e => console.error('Failed to dispose model:', e));
            }, 500);
        }
    }

    return {
        success: true,
        pastedText: textToPaste,
        rawText: text,
        llmProcessed: didRunLlm,
        processedResult: processedOutput,
        intent: capturedIntent,
        intentLabel: intentLabel,
        intentLabels: intentLabels,
        shouldBlockPaste: !!shouldBlockPaste,
    };
});

function simulatePaste() {
    const { exec } = require('child_process');

    if (process.platform === 'win32') {
        // Simple approach: just send Ctrl+V using PowerShell
        // The text is already in clipboard, just paste to focused window
        exec('powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'^v\')"',
            (err, stdout, stderr) => {
                if (err) {
                    console.error('Paste failed:', err);
                    // Fallback: try with wscript
                    exec('powershell -Command "$wsh = New-Object -ComObject WScript.Shell; $wsh.SendKeys(\'^v\')"',
                        (err2) => {
                            if (err2) console.error('Fallback paste also failed:', err2);
                        });
                } else {
                    console.log('Paste executed successfully');
                }
            }
        );
    } else if (process.platform === 'darwin') {
        exec(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`);
    } else {
        exec(`xdotool key ctrl+v`);
    }
}

// Existing handlers for main window
ipcMain.handle('paste-text', async (event, text) => {
    clipboard.writeText(text);
    return { success: true };
});

ipcMain.handle('get-window-type', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win === indicatorWindow) return 'indicator';
    if (win === mainWindow) return 'main';
    if (win === reviewPopupWindow) return 'review-popup';
    return 'unknown';
});

ipcMain.handle('save-to-history', async (event, recording) => {
    if (mainWindow) {
        safeSend(mainWindow, 'add-recording', recording);
        return { success: true };
    }
    return { success: false, error: 'Main window not available' };
});

// Whisper transcription
const whisperService = require('./whisperService.cjs');
const whisperCppService = require('./whisperCppService.cjs');
const whisperCppDownloader = require('./whisperCppDownloader.cjs');
const gpuDetector = require('./gpuDetector.cjs');

ipcMain.handle('whisper-transcribe', async (event, audioData, options = {}) => {
    const store = await getSettingsStore();
    const modelId = options.modelId || store.get('whisperModel');
    const storedLang = options.language || store.get('whisperLanguage') || 'auto';
    // English-only models don't accept a language param; 'auto' means let Whisper detect
    const language = modelId.endsWith('.en') ? undefined : (storedLang === 'auto' ? undefined : storedLang);
    const result = await whisperService.transcribe(audioData, {
        ...options,
        modelId,
        language,
        onProgress: (progress) => {
            if (event.sender && !event.sender.isDestroyed()) {
                event.sender.send('whisper-cpp-progress', { type: 'model', ...progress });
            }
        },
    });
    // VRAM-01/02: capture PID from whisperCppService results so llamaService can confirm
    // the Whisper process is dead before loading the LLM server.
    _lastWhisperCppPid = result.pid || null;
    return result;
});

ipcMain.handle('whisper-model-exists', async (event, modelName) => {
    return whisperService.modelExists(modelName);
});

ipcMain.handle('whisper-download-model', async (event, modelName) => {
    return await whisperService.downloadModel(modelName);
});

ipcMain.handle('whisper-get-model-path', () => {
    return whisperService.getModelPath();
});

// Settings handlers
ipcMain.handle('settings-get', async () => {
    const store = await getSettingsStore();
    const isAutoLaunchEnabled = await autoLauncher.isEnabled();
    return {
        whisperModel: store.get('whisperModel'),
        whisperLanguage: store.get('whisperLanguage'),
        firstRunComplete: store.get('firstRunComplete'),
        autoLaunch: isAutoLaunchEnabled,
        whisperCppEnabled: store.get('whisperCppEnabled'),
        llmEnabled: store.get('llmEnabled'),
        llmGpuMode: store.get('llmGpuMode'),
        reviewFirstMode: store.get('reviewFirstMode', false),
        llmModelPreference: store.get('llmModelPreference', 'auto'),
        hotkeyTranscribe: store.get('hotkeyTranscribe', 'CommandOrControl+Alt+V'),
        hotkeyLlm: store.get('hotkeyLlm', 'CommandOrControl+Alt+P'),
    };
});

const ALLOWED_SETTING_KEYS = ['whisperModel', 'whisperLanguage', 'firstRunComplete', 'autoLaunch', 'whisperCppEnabled', 'llmFirstUsePromptDismissed', 'llmEnabled', 'llmGpuMode', 'reviewFirstMode', 'llmModelPreference', 'hotkeyTranscribe', 'hotkeyLlm'];

ipcMain.handle('settings-set', async (event, key, value) => {
    if (!ALLOWED_SETTING_KEYS.includes(key)) {
        return { success: false, error: 'Unknown setting key' };
    }
    // Validate hotkey accelerator strings
    if (key === 'hotkeyTranscribe' || key === 'hotkeyLlm') {
        if (typeof value !== 'string' || value.trim().length === 0) {
            return { success: false, error: 'Hotkey must be a non-empty string' };
        }
        value = value.trim();
    }
    const store = await getSettingsStore();
    store.set(key, value);
    // Sync model preference to llamaService when changed
    if (key === 'llmModelPreference') {
        llamaService.setModelPreference(value);
    }
    if (key === 'llmGpuMode') {
        llamaService.setGpuMode(value);
    }
    // Re-register global shortcuts when hotkeys change
    if (key === 'hotkeyTranscribe' || key === 'hotkeyLlm') {
        reregisterGlobalShortcuts();
    }
    return { success: true };
});

// Auto-launch handlers
ipcMain.handle('auto-launch-get', async () => {
    try {
        return await autoLauncher.isEnabled();
    } catch (error) {
        console.error('Failed to get auto-launch status:', error);
        return false;
    }
});

ipcMain.handle('auto-launch-set', async (event, enabled) => {
    try {
        if (enabled) {
            await autoLauncher.enable();
        } else {
            await autoLauncher.disable();
        }
        const store = await getSettingsStore();
        store.set('autoLaunch', enabled);
        return { success: true, enabled };
    } catch (error) {
        console.error('Failed to set auto-launch:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('get-available-models', () => {
    return AVAILABLE_WHISPER_MODELS;
});

ipcMain.handle('whisper-change-model', async (event, modelId) => {
    try {
        // Dispose current model
        await whisperService.dispose();

        // Save new preference
        const store = await getSettingsStore();
        store.set('whisperModel', modelId);

        return { success: true, modelId };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('whisper-preload-model', async (event, modelId) => {
    return await whisperService.preloadModel(modelId);
});

ipcMain.handle('whisper-get-current-model', async () => {
    const store = await getSettingsStore();
    return whisperService.getCurrentModel() || store.get('whisperModel');
});

ipcMain.handle('save-audio-temp', async (event, arrayBuffer, filename) => {
    const tempDir = app.getPath('temp');
    const safeName = path.basename(filename || `recording-${Date.now()}.webm`);
    const filePath = path.join(tempDir, safeName);

    // Verify resolved path stays inside temp directory
    if (!path.resolve(filePath).startsWith(path.resolve(tempDir) + path.sep)) {
        return { success: false, error: 'Invalid filename' };
    }

    try {
        fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
        return { success: true, path: filePath };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('save-audio-file', async (event, sourcePath) => {
    const { dialog } = require('electron');

    try {
        // Restrict source path to temp directory
        const tempDir = path.resolve(app.getPath('temp'));
        const resolvedSource = path.resolve(sourcePath);
        if (!resolvedSource.startsWith(tempDir + path.sep)) {
            return { success: false, error: 'Access denied: path outside allowed directory' };
        }

        if (!fs.existsSync(sourcePath)) {
            return { success: false, error: 'Source file not found' };
        }

        const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
            title: 'Save Audio Recording',
            defaultPath: `recording-${Date.now()}.webm`,
            filters: [
                { name: 'Audio Files', extensions: ['webm', 'wav', 'mp3'] }
            ]
        });

        if (canceled || !filePath) {
            return { success: false, canceled: true };
        }

        fs.copyFileSync(sourcePath, filePath);
        return { success: true, filePath };
    } catch (error) {
        console.error('Failed to save audio file:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('read-audio-file', async (event, filePath) => {
    try {
        // Restrict reads to the temp directory
        const tempDir = path.resolve(app.getPath('temp'));
        const resolvedPath = path.resolve(filePath);
        if (!resolvedPath.startsWith(tempDir + path.sep)) {
            return { success: false, error: 'Access denied: path outside allowed directory' };
        }

        if (!fs.existsSync(filePath)) {
            return { success: false, error: 'File not found' };
        }
        const buffer = fs.readFileSync(filePath);
        return { success: true, buffer }; // Returns Uint8Array to renderer
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// GPU detection
ipcMain.handle('gpu-detect', async () => {
    return await gpuDetector.detectGpu();
});

// whisper.cpp GPU backend management
ipcMain.handle('whisper-cpp-status', async () => {
    const store = await getSettingsStore();
    const modelId = store.get('whisperModel');
    return whisperCppService.getStatus(modelId);
});

ipcMain.handle('whisper-cpp-setup', async (event, { modelId, backend } = {}) => {
    const store = await getSettingsStore();
    const targetModel = modelId || store.get('whisperModel');
    const results = { binary: null, model: null };

    try {
        // Download binary if needed (or if switching backends)
        const currentBackend = whisperCppService.getStatus(targetModel).installedBackend;
        const needsBinary = !whisperCppService.findBinary() || (backend && backend !== currentBackend);

        if (needsBinary) {
            results.binary = await whisperCppDownloader.downloadBinary((progress) => {
                if (event.sender && !event.sender.isDestroyed()) {
                    event.sender.send('whisper-cpp-progress', { type: 'binary', ...progress });
                }
            }, backend || undefined);
        } else {
            results.binary = { success: true, binaryPath: whisperCppService.findBinary(), backend: currentBackend };
        }

        // Download model if needed
        if (!whisperCppService.findModel(targetModel)) {
            results.model = await whisperCppDownloader.downloadModel(targetModel, (progress) => {
                if (event.sender && !event.sender.isDestroyed()) {
                    event.sender.send('whisper-cpp-progress', { type: 'model', ...progress });
                }
            });
        } else {
            results.model = { success: true, modelPath: whisperCppService.findModel(targetModel) };
        }

        return { success: true, ...results };
    } catch (error) {
        console.error('whisper.cpp setup failed:', error);
        return { success: false, error: error.message, ...results };
    }
});

// ─── LLM Model Management IPC Handlers ────────────────────────────────────────

/**
 * llm:get-model-status — returns installed state of each model.
 * Renderer uses this to decide whether to show download or delete buttons.
 */
ipcMain.handle('llm:get-model-status', () => {
    return modelRegistry.getModelStatus();
});

/**
 * llm:download-model — enqueue a model download with real-time progress.
 * Only one download runs at a time; a second request queues behind the first.
 * Progress events throttled to max 4/sec (250ms minimum interval).
 */
ipcMain.handle('llm:download-model', (event, { modelId }) => {
    if (!llamaDownloader.MODELS[modelId]) {
        return Promise.resolve({ success: false, error: `Unknown model ID: "${modelId}"` });
    }

    // Create a cancel token for this download
    const cancelToken = { cancel: null };
    _cancelTokens[modelId] = cancelToken;

    // Enqueue download — serializes against other downloads
    const task = _downloadQueue.then(async () => {
        _activeDownloads.add(modelId);

        let lastProgressTime = 0;
        const onProgress = (progress) => {
            const now = Date.now();
            if (now - lastProgressTime >= 250) {
                lastProgressTime = now;
                if (event.sender && !event.sender.isDestroyed()) {
                    event.sender.send('llm:download-progress', { modelId, ...progress });
                }
            }
        };

        try {
            const store = await getSettingsStore();
            await ensureLlamaBinaryForMode(store, event.sender, cancelToken);

            await llamaDownloader.downloadModel(modelId, onProgress, cancelToken);
            return { success: true, modelId };
        } catch (err) {
            return { success: false, error: err.message };
        } finally {
            _activeDownloads.delete(modelId);
            delete _cancelTokens[modelId];
        }
    });

    // Extend the queue chain (swallowing rejection so queue stays healthy)
    _downloadQueue = task.catch(() => {});

    return task;
});

/**
 * llm:download-binary — explicitly download the llama-server binary.
 * Respects GPU mode setting for CUDA vs CPU variant selection.
 */
ipcMain.handle('llm:download-binary', async (event) => {
    const store = await getSettingsStore();
    try {
        return await ensureLlamaBinaryForMode(store, event.sender);
    } catch (err) {
        return { success: false, error: err.message };
    }
});

/**
 * llm:cancel-download — cancel an in-progress download.
 */
ipcMain.handle('llm:cancel-download', (event, { modelId }) => {
    const token = _cancelTokens[modelId];
    if (token && typeof token.cancel === 'function') {
        token.cancel();
        return { success: true, modelId };
    }
    return { success: false, error: `No active download for "${modelId}"` };
});

/**
 * llm:delete-model — delete a model file from disk.
 * If llamaService is running the same model, kills it first.
 */
ipcMain.handle('llm:delete-model', async (event, { modelId }) => {
    if (!llamaDownloader.MODELS[modelId]) {
        return { success: false, error: `Unknown model ID: "${modelId}"` };
    }

    try {
        const modelsPath = llamaDownloader.getModelsPath();
        const modelFilename = llamaDownloader.MODELS[modelId].filename;
        const modelPath = path.join(modelsPath, modelFilename);
        const partialPath = modelPath + '.partial';

        // Kill llamaService if it's currently running (may have this model loaded)
        if (llamaService.isRunning()) {
            console.log(`[llm:delete-model] Killing llamaService before deleting "${modelId}"`);
            await llamaService.kill();
        }

        // Delete the model file if it exists
        if (fs.existsSync(modelPath)) {
            fs.unlinkSync(modelPath);
            console.log(`[llm:delete-model] Deleted: ${modelPath}`);
        }

        // Also delete any in-progress .partial file
        if (fs.existsSync(partialPath)) {
            fs.unlinkSync(partialPath);
            console.log(`[llm:delete-model] Deleted partial: ${partialPath}`);
        }

        return { success: true, modelId };
    } catch (err) {
        console.error(`[llm:delete-model] Failed to delete "${modelId}":`, err.message);
        return { success: false, error: err.message };
    }
});

/**
 * llm:get-server-status — return current LLM server status.
 */
ipcMain.handle('llm:get-server-status', () => {
    return {
        status: _currentLlmStatus,
        isRunning: llamaService.isRunning(),
    };
});

/**
 * llm:set-gpu-mode — set LLM inference GPU mode and restart llamaService if running.
 * Valid modes: 'auto' (use GPU if available), 'gpu' (force all layers on GPU), 'cpu' (0 GPU layers).
 */
ipcMain.handle('llm:set-gpu-mode', async (event, mode) => {
    const validModes = ['auto', 'gpu', 'cpu'];
    if (!validModes.includes(mode)) {
        return { success: false, error: `Invalid mode "${mode}". Must be one of: auto, gpu, cpu` };
    }
    const store = await getSettingsStore();
    store.set('llmGpuMode', mode);
    llamaService.setGpuMode(mode);
    // Kill llamaService if running so next inference picks up the new mode
    if (llamaService.isRunning()) {
        await llamaService.kill();
    }
    return { success: true, mode };
});

/**
 * llm:check-active — returns whether LLM inference is currently running.
 * Used by SettingsModal confirmation dialog when disabling LLM during active inference.
 */
ipcMain.handle('llm:check-active', () => {
    return { active: llamaService.isRunning() };
});

/**
 * llm:open-setup — focus/show the main window so user can download a model.
 * Called when user clicks "Download now" in the first-use prompt (UI-03).
 */
ipcMain.handle('llm:open-setup', () => {
    showMainWindow();
    // Deep-link: tell the renderer to open SettingsModal to LLM section
    safeSend(mainWindow, 'llm:open-settings-llm');
    return { success: true };
});

/**
 * llm:set-indicator-interactive — enable/disable mouse events on the indicator window.
 * Called when the first-use prompt is shown/dismissed so the user can click buttons.
 *
 * @param {boolean} interactive - true = respond to mouse, false = pass-through (default)
 */
ipcMain.handle('llm:set-indicator-interactive', (event, interactive) => {
    if (indicatorWindow && !indicatorWindow.isDestroyed()) {
        indicatorWindow.setIgnoreMouseEvents(!interactive);
        if (interactive) {
            // Make focusable so button clicks register
            indicatorWindow.setFocusable(true);
        } else {
            indicatorWindow.setFocusable(false);
        }
    }
    return { success: true };
});
