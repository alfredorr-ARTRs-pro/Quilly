const { app, BrowserWindow, globalShortcut, screen, clipboard, Tray, Menu, nativeImage, Notification, shell, session, systemPreferences, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const AutoLaunch = require('auto-launch');
const platformUtils = require('./platformUtils.cjs');
const updateChecker = require('./updateChecker.cjs');

// LLM pipeline modules
const pipeline = require('./pipeline.cjs');
const modelRegistry = require('./modelRegistry.cjs');
const llamaService = require('./llamaService.cjs');
const llamaDownloader = require('./llamaDownloader.cjs');
const liveLlmService = require('./liveLlmService.cjs');
const promptConfig = require('./promptConfig.cjs');
// intentRouter routing runs inside pipeline.cjs; main only pushes the wake-word setting into it
const intentRouter = require('./intentRouter.cjs');

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
                finalTranscriptCleanupEnabled: false,
                developerSettingsEnabled: false,
                activePromptProfileId: null,
                promptProfiles: null,
            }
        });
        const previousLiveCleanupMode = settingsStore.get('liveCleanupMode', 'raw');
        const postCleanupModeVersion = settingsStore.get('postCleanupModeVersion', 1);
        if (postCleanupModeVersion < 2) {
            settingsStore.set('finalTranscriptCleanupEnabled', previousLiveCleanupMode === 'tiny-llm');
            settingsStore.set('postCleanupModeVersion', 2);
        }
        if (settingsStore.get('liveDraftEnabled', false)) {
            settingsStore.set('liveDraftEnabled', false);
        }
    }
    return settingsStore;
};

// Available Whisper models (ggmlName used by whisper.cpp, ggmlSize is the GGML file size)
const AVAILABLE_WHISPER_MODELS = [
    { id: 'Xenova/whisper-tiny.en', name: 'Tiny (English)', size: '~39MB', ggmlName: 'ggml-tiny.en.bin', ggmlSize: '~75MB', description: 'Fastest, English only' },
    { id: 'Xenova/whisper-base', name: 'Base', size: '~74MB', ggmlName: 'ggml-base.bin', ggmlSize: '~142MB', description: 'Fast, multilingual' },
    { id: 'Xenova/whisper-small', name: 'Small (Recommended)', size: '~244MB', ggmlName: 'ggml-small.bin', ggmlSize: '~466MB', description: 'Best balance of speed, accuracy, and size' },
    { id: 'Xenova/whisper-medium', name: 'Medium', size: '~769MB', ggmlName: 'ggml-medium.bin', ggmlSize: '~1.5GB', description: 'Higher accuracy, larger download' },
    { id: 'onnx-community/whisper-large-v3-turbo', name: 'Large v3 Turbo', size: '~809MB', ggmlName: 'ggml-large-v3-turbo.bin', ggmlSize: '~1.6GB', description: 'Near Large v3 accuracy at several times the speed — best choice on GPUs' },
    { id: 'Xenova/whisper-large-v3', name: 'Large v3', size: '~1.5GB', ggmlName: 'ggml-large-v3.bin', ggmlSize: '~3.1GB', description: 'Highest accuracy' },
    { id: 'ggml-org/parakeet-tdt-0.6b-v3', name: 'Parakeet v3', size: '~1.2GB', ggmlName: 'ggml-parakeet-tdt-0.6b-v3-f16.bin', ggmlSize: '~1.2GB', description: 'NVIDIA Parakeet — much faster than Whisper; auto-detects 25 European languages (language setting not used)' },
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
// Per-model task promises (set the moment a download is REQUESTED, before its
// queued task starts) so cancel/delete can target one model without touching —
// or waiting on — unrelated downloads queued behind it.
const _downloadTasks = {};

// Tracks current LLM status for llm:get-server-status responses
let _currentLlmStatus = 'idle';

// VRAM-01/02: Stores the last whisper.cpp subprocess PID so llamaService.setWhisperPid()
// can confirm the Whisper process is dead before spawning the LLM server.
let _lastWhisperCppPid = null;

// Determine if we're in development mode
const isDev = !app.isPackaged;

// Durable location for recording audio. OS temp gets swept by Windows, which
// would silently break playback and send-to-editor for older entries; keep
// recordings under userData instead. Created lazily/on-demand.
function getRecordingsDir() {
    const dir = path.join(app.getPath('userData'), 'recordings');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    return dir;
}

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
        // Quilly is audio-only: never grant camera access.
        const wantsVideo = (details?.mediaTypes || []).includes('video');
        callback(permission === 'media' && !wantsVideo && isAllowedAppUrl(requestingUrl));
    });
}

// Resolve the app icon. On Windows use the multi-size .ico so the taskbar and
// window get a crisp icon at every DPI; a single 256px PNG can render blurry
// or fail to associate with the taskbar button. Other platforms keep the PNG.
function appIconPath() {
    const base = isDev ? path.join(__dirname, '../public') : path.join(__dirname, '../dist');
    return process.platform === 'win32'
        ? path.join(base, 'icon.ico')
        : path.join(base, 'icon.png');
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
        icon: appIconPath(),
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

function positionIndicatorNearCursor(sizeOverride = null) {
    if (!indicatorWindow || indicatorWindow.isDestroyed()) return;

    const cursorPoint = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursorPoint).workArea;
    const bounds = indicatorWindow.getBounds();
    const width = sizeOverride?.width || bounds.width || INDICATOR_BASE_SIZE.width;
    const height = sizeOverride?.height || bounds.height || INDICATOR_BASE_SIZE.height;
    const margin = 12;

    const x = Math.min(
        Math.max(cursorPoint.x + 20, display.x + margin),
        display.x + display.width - width - margin
    );
    const y = Math.min(
        Math.max(cursorPoint.y + 20, display.y + margin),
        display.y + display.height - height - margin
    );

    indicatorWindow.setPosition(Math.round(x), Math.round(y));
    lastCursorPos = cursorPoint;
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

    const loadIndicatorContent = () => {
        if (!indicatorWindow || indicatorWindow.isDestroyed()) return;
        if (isDev) {
            indicatorWindow.loadURL('http://localhost:9500/#/indicator');
        } else {
            indicatorWindow.loadFile(path.join(__dirname, '../dist/index.html'), { hash: 'indicator' });
        }
    };

    // Load the indicator route
    loadIndicatorContent();

    attachNavigationGuards(indicatorWindow);

    // Ignore mouse events - purely visual indicator
    indicatorWindow.setIgnoreMouseEvents(true);

    // Capture this instance so a stale 'closed' (e.g. from destroy() during
    // crash recovery) can't null out a newer replacement window.
    const thisWindow = indicatorWindow;
    thisWindow.on('closed', () => {
        if (indicatorWindow !== thisWindow) return;
        stopCursorTracking();
        indicatorWindow = null;
        indicatorReady = null;
    });

    let loadRetries = 0;

    indicatorWindow.webContents.on('did-finish-load', () => {
        console.log('Indicator window loaded successfully');
        loadRetries = 0;
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
        // -3 (ABORTED) fires on in-flight navigation replacement — not a real failure
        if (errorCode === -3) return;
        console.error('Indicator window failed to load:', errorCode, errorDescription);
        // Without a retry, indicatorReady never resolves and showIndicator()
        // would hang — leaving isStarting/isBusy stuck and hotkeys dead.
        if (loadRetries < 5) {
            loadRetries++;
            const delay = 1000 * loadRetries;
            console.warn(`[main] Retrying indicator load in ${delay}ms (attempt ${loadRetries}/5)`);
            setTimeout(loadIndicatorContent, delay);
        }
    });

    // If the renderer process dies (GPU reset, OOM, crash), the transparent
    // window silently renders nothing — an invisible bubble — and any active
    // recording state can never complete. Reset state and rebuild the window
    // so the next hotkey press works immediately.
    indicatorWindow.webContents.on('render-process-gone', (event, details) => {
        console.error('[main] Indicator renderer gone:', details.reason);
        const dead = indicatorWindow;
        indicatorWindow = null;
        indicatorReady = null;
        indicatorReadyResolve = null;
        hideIndicator(); // resets isRecording/isBusy/isStarting/isStopping + watchdog
        if (dead && !dead.isDestroyed()) {
            try { dead.destroy(); } catch (_) { /* ignore */ }
        }
        createIndicatorWindow();
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
    if (!indicatorWindow || indicatorWindow.isDestroyed()) return;

    // Self-heal: cursor tracking only runs between showIndicator() and
    // hideIndicator() — the exact span the bubble MUST be on screen. If the
    // window lost visibility (failed show, display/DPI change, another app
    // stealing z-order), put it back within one tick.
    if (!indicatorWindow.isVisible()) {
        console.warn('[main] Indicator vanished while active — re-showing');
        positionIndicatorNearCursor();
        indicatorWindow.showInactive();
        indicatorWindow.setAlwaysOnTop(true, 'screen-saver');
        indicatorWindow.moveTop();
        return;
    }

    const cursorPoint = screen.getCursorScreenPoint();

    // Only update if cursor moved
    if (cursorPoint.x !== lastCursorPos.x || cursorPoint.y !== lastCursorPos.y) {
        positionIndicatorNearCursor();
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
    if (!indicatorWindow || indicatorWindow.isDestroyed()) {
        // Should be pre-loaded, but recreate if missing
        createIndicatorWindow();
    }

    // Wait for indicator content to be loaded before showing — but never
    // forever: if the load is wedged (did-fail-load retries exhausted), an
    // unbounded await would leave isStarting/isBusy stuck and kill hotkeys.
    if (indicatorReady) {
        const loaded = await Promise.race([
            indicatorReady.then(() => true),
            new Promise(resolve => setTimeout(() => resolve(false), 5000)),
        ]);
        if (!loaded) {
            throw new Error('Indicator window did not finish loading within 5s');
        }
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
    positionIndicatorNearCursor(INDICATOR_BASE_SIZE);
    indicatorWindow.showInactive();

    // Re-assert topmost status on EVERY show. The always-on-top flag is only
    // applied once at creation and can be lost across hide/show cycles on
    // Windows (other topmost windows, fullscreen apps) — the classic cause of
    // "recording works but the bubble never appears". 'screen-saver' is the
    // highest z-order level, above fullscreen windows.
    indicatorWindow.setAlwaysOnTop(true, 'screen-saver');
    indicatorWindow.moveTop();

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
    // reloaded mid-recording and lost React state), reset isBusy so the user isn't
    // permanently locked out. 300s comfortably exceeds the 120s LLM pipeline /
    // final-cleanup timeouts plus whisper transcription of typical hotkey
    // recordings. (Very long recordings can legitimately exceed even this — the
    // watchdog is a lockout-recovery backstop, not a hard processing limit.)
    if (_busyWatchdog) clearTimeout(_busyWatchdog);
    _busyWatchdog = setTimeout(() => {
        if (isBusy) {
            console.warn('[main] Watchdog: isBusy stuck for 300s — force-resetting state');
            hideIndicator();
        }
        _busyWatchdog = null;
    }, 300_000);

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

const FINAL_CLEANUP_TIMEOUT_MS = 120_000;
const FINAL_CLEANUP_TIMEOUT_CPU_MS = 30_000;
// Runaway-rewrite guard: a faithful cleanup keeps roughly the input length. If the model
// returns more than 1.5x the input, treat it as a hallucinated rewrite and fall back to
// the local-structure-only result.
const FINAL_CLEANUP_MAX_LENGTH_RATIO = 1.5;

const withTimeout = (promise, timeoutMs, message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise
        .then((value) => {
            clearTimeout(timer);
            resolve(value);
        })
        .catch((err) => {
            clearTimeout(timer);
            reject(err);
        });
});

const getActiveDeveloperPromptConfig = (store) => {
    const config = promptConfig.getDeveloperConfigFromStore(store);
    if (!config.enabled) {
        return { enabled: false, ...config.installedProfile };
    }
    const activeProfile = config.profiles.find(profile => profile.id === config.activeProfileId)
        || config.profiles[0]
        || promptConfig.createInstalledProfile();
    return { enabled: config.enabled, ...activeProfile };
};

const buildFinalCleanupMessages = (profile, rawText, structuredDraft = null) => {
    const prompt = profile.finalCleanup?.systemPrompt || promptConfig.DEFAULT_FINAL_CLEANUP_PROMPT;
    // Append /no_think for Qwen3 family compatibility. Qwen3 has reasoning enabled by
    // default and will spend the entire n_predict budget inside <think>...</think>
    // before emitting the JSON answer, leading to empty cleanup output. The /no_think
    // directive disables it. Qwen3.5 (and unrelated models) ignore the unknown directive.
    const promptWithThinkingOff = `${prompt}\n\n/no_think`;
    const payload = structuredDraft && structuredDraft !== rawText && profile.finalCleanup?.sendLocalStructureDraft !== false
        ? { rawText, locallyStructuredDraft: structuredDraft }
        : { rawText };

    return [
        { role: 'system', content: promptWithThinkingOff },
        { role: 'user', content: JSON.stringify(payload) },
    ];
};

const runMainModelFinalCleanup = async ({ profile, rawText, structuredDraft, store, sender, cancelToken }) => {
    const modelId = profile.finalCleanup?.modelId || 'auto';
    const messages = buildFinalCleanupMessages(profile, rawText, structuredDraft);

    console.log('\n[final-cleanup][main helper system prompt]');
    console.log(messages[0].content);
    console.log('[final-cleanup][end main helper system prompt]\n');
    console.log('[final-cleanup][main helper user input]');
    console.log(messages[1].content);
    console.log('[final-cleanup][end main helper user input]\n');

    await ensureLlamaBinaryForMode(store, sender, cancelToken);
    // Tight cap: a faithful cleanup should not grow the text. Allow ~15% headroom over
    // estimated input tokens (chars/3.5 for mixed-language safety) plus 80 tokens for the
    // JSON wrapper. Floor at 256 so very short inputs still complete; ceiling at 1024 to
    // hard-stop runaway rewrites. Skip-cleanup short-circuit means inputs <250 chars rarely
    // hit this path.
    const maxTokens = Math.min(1024, Math.max(256, Math.ceil(rawText.length / 3.5) + 80));
    const temperature = profile.finalCleanup?.temperature ?? 0.1;

    const output = await llamaService.inferWithModel(modelId, messages, temperature, { maxTokens });

    console.log('[final-cleanup][main helper raw output]');
    console.log(output);
    console.log('[final-cleanup][end main helper raw output]\n');

    const parsed = liveLlmService._internal.parseFinalCleanupOutput(output);
    const cleanedText = liveLlmService.structureFinalText(
        parsed.text,
        profile.finalCleanup?.localStructureRules
    );

    return {
        text: cleanedText,
        editSummary: liveLlmService._internal.sanitizeEditSummary(parsed.editSummary, 'main model final cleanup'),
        responseFormat: parsed.responseFormat,
        modelId,
    };
};

async function runFinalTranscriptCleanup(text, store, sender = null, options = {}) {
    // Strip Whisper non-speech artifacts ([BLANK_AUDIO], [Music], etc) up front so
    // they never reach the LLM, the local-structure rules, or the user's pasted text.
    const rawText = liveLlmService.stripWhisperArtifacts(String(text || '').trim());
    if (!rawText || (!options.force && !store.get('finalTranscriptCleanupEnabled', false))) {
        if (rawText) console.log('[final-cleanup] skipped: setting disabled');
        return options.includeDiagnostics ? { cleanup: null, diagnostics: { rawText } } : null;
    }

    const activeProfile = options.profile
        ? { enabled: true, ...promptConfig.sanitizeProfile(options.profile) }
        : getActiveDeveloperPromptConfig(store);
    const finalConfig = activeProfile.finalCleanup || promptConfig.createInstalledProfile().finalCleanup;
    const localRules = finalConfig.localStructureRules || promptConfig.DEFAULT_LOCAL_STRUCTURE_RULES;
    const diagnostics = {
        rawText,
        profileName: activeProfile.name,
        modelId: finalConfig.modelId,
        localStructureOutput: null,
        modelOutput: null,
        selectedOutput: null,
        responseFormat: null,
        error: null,
    };

    console.log('\n[final-cleanup][raw transcript input]');
    console.log(rawText);
    console.log('[final-cleanup][end raw transcript input]\n');

    const structuredFallbackText = liveLlmService.structureFinalText(rawText, localRules);
    const fallbackCleanup = structuredFallbackText && structuredFallbackText !== rawText
        ? { text: structuredFallbackText, editSummary: 'local final structure cleanup' }
        : null;
    diagnostics.localStructureOutput = structuredFallbackText;

    if (fallbackCleanup) {
        console.log('[final-cleanup][local structure output]');
        console.log(fallbackCleanup.text);
        console.log('[final-cleanup][end local structure output]\n');
    } else {
        console.log('[final-cleanup] local structure cleanup made no changes');
    }

    if (!store.get('llmEnabled', true)) {
        console.log('[final-cleanup] AI processing disabled; using local structure cleanup only');
        diagnostics.selectedOutput = fallbackCleanup?.text || null;
        return options.includeDiagnostics ? { cleanup: fallbackCleanup, diagnostics } : fallbackCleanup;
    }

    // Short-circuit: skip the LLM for short, well-formed inputs. Local-structure cleanup
    // already ran above; if it produced no changes the caller pastes rawText untouched.
    // This saves several seconds of latency on the common "send a quick command" case.
    if (!options.force && promptConfig.shouldSkipFinalCleanup(rawText)) {
        console.log(`[final-cleanup] skipped LLM: rawText length=${rawText.length} already well-formed`);
        diagnostics.selectedOutput = fallbackCleanup?.text || null;
        diagnostics.skipped = 'short-well-formed';
        return options.includeDiagnostics ? { cleanup: fallbackCleanup, diagnostics } : fallbackCleanup;
    }

    llamaService.setGpuMode(store.get('llmGpuMode', 'auto'));

    const selectedModelId = finalConfig.modelId || 'auto';
    const gpuMode = store.get('llmGpuMode', 'auto');
    // CPU-only systems are 5-10x slower per token. Use a tighter timeout so the user is
    // not left staring at a spinner. If cleanup overruns, the catch block falls through
    // to the local-structure-only result.
    const cleanupTimeoutMs = gpuMode === 'cpu' ? FINAL_CLEANUP_TIMEOUT_CPU_MS : FINAL_CLEANUP_TIMEOUT_MS;
    const cancelToken = { cancel: null };

    // Final-cleanup token streaming removed; only the final output is shown/pasted.
    try {
        console.log(`[final-cleanup] starting cleanup length=${rawText.length} model=${selectedModelId} gpuMode=${gpuMode} timeoutMs=${cleanupTimeoutMs}`);
        const cleanup = await withTimeout(
            runMainModelFinalCleanup({
                profile: activeProfile,
                rawText,
                structuredDraft: finalConfig.sendLocalStructureDraft === false ? null : structuredFallbackText,
                store,
                sender,
                cancelToken,
            }),
            cleanupTimeoutMs,
            'final cleanup timed out'
        );
        if (cleanup?.text && cleanup.text.trim()) {
            // Runaway-rewrite guard: drop the model's output and use the local-structure
            // result if the cleanup blew up the text. Catches the over-rewriting failure
            // mode where smaller models add framing/paraphrasing instead of editing.
            const ratio = cleanup.text.length / Math.max(rawText.length, 1);
            if (ratio > FINAL_CLEANUP_MAX_LENGTH_RATIO) {
                console.warn(`[final-cleanup] output too long (ratio=${ratio.toFixed(2)} > ${FINAL_CLEANUP_MAX_LENGTH_RATIO}); falling back to local structure`);
                diagnostics.error = `cleanup-overrun ratio=${ratio.toFixed(2)}`;
                diagnostics.modelOutput = cleanup.text;
                diagnostics.selectedOutput = fallbackCleanup?.text || null;
                return options.includeDiagnostics ? { cleanup: fallbackCleanup, diagnostics } : fallbackCleanup;
            }
            diagnostics.modelOutput = cleanup.text;
            diagnostics.selectedOutput = cleanup.text;
            diagnostics.responseFormat = cleanup.responseFormat || null;
            console.log(`[final-cleanup] cleanup applied length=${cleanup.text.length} model=${selectedModelId} format=${cleanup.responseFormat || 'unknown'}`);
            console.log('[final-cleanup][selected helper output]');
            console.log(cleanup.text);
            console.log('[final-cleanup][end selected helper output]\n');
            return options.includeDiagnostics ? { cleanup, diagnostics } : cleanup;
        }
    } catch (err) {
        if (typeof cancelToken.cancel === 'function') {
            cancelToken.cancel();
        }
        await llamaService.kill().catch(() => {});
        diagnostics.error = err.message;
        console.warn('[final-cleanup] Cleanup model failed; using local structure cleanup only:', err.message);
    }

    diagnostics.selectedOutput = fallbackCleanup?.text || null;
    return options.includeDiagnostics ? { cleanup: fallbackCleanup, diagnostics } : fallbackCleanup;
}

// App lifecycle
app.whenReady().then(() => {
    // Ensures Windows toast notifications display correctly (even in dev builds).
    // Dev runs execute as electron.exe (Electron's icon); sharing the installed
    // app's AppUserModelId lets Windows cache the Electron icon against Quilly's
    // taskbar identity — the installed app then shows the Electron logo until
    // the icon cache is rebuilt. Keep dev under a separate id.
    // The MSIX (Store) package already has an AppUserModelId derived from its
    // package identity; overriding it would detach toasts from the package.
    if (process.platform === 'win32' && !process.windowsStore) {
        app.setAppUserModelId(isDev ? 'com.quilly.app.dev' : 'com.quilly.app');
    }
    setupPermissionHandler();
    scheduleAutoUpdateCheck();
    getRecordingsDir(); // ensure the durable recordings dir exists before first use

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
        // Wake word must reach both the intent router (detection) and
        // whisper.cpp (--prompt recognition bias) or custom wake words
        // silently don't work.
        const wakeWord = store.get('wakeWord', 'quilly');
        intentRouter.setWakeWord(wakeWord);
        whisperCppService.setWhisperPrompt(wakeWord);
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

        console.log('[main] Ensuring llama-server binary matches selected GPU mode...');
        try {
            await ensureLlamaBinaryForMode(store);
            console.log('[main] LLM runtime ready');
        } catch (err) {
            console.error('[main] LLM runtime setup failed (non-fatal):', err.message);
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

// Electron does not await async 'will-quit' handlers — without preventDefault
// the process can exit before llamaService.kill() completes, orphaning a
// llama-server.exe that holds VRAM until the next launch's zombie cleanup.
let _quitCleanupDone = false;
app.on('will-quit', (event) => {
    if (_quitCleanupDone) return;
    event.preventDefault();

    globalShortcut.unregisterAll();
    stopCursorTracking();

    const cleanup = Promise.allSettled([
        llamaService.kill().catch(e => console.error('[quit] llama kill:', e.message)),
        (async () => {
            const whisperService = require('./whisperService.cjs');
            await whisperService.dispose();
        })().catch(e => console.error('[quit] whisper dispose:', e.message)),
    ]);

    // Hard cap so a hung kill can never block quitting for more than 5s.
    const deadline = new Promise(resolve => setTimeout(resolve, 5000));
    Promise.race([cleanup, deadline]).finally(() => {
        _quitCleanupDone = true;
        app.quit();
    });
});

/**
 * macOS only: keystroke simulation (System Events) requires the app to be
 * trusted under System Settings → Privacy & Security → Accessibility.
 * Returns true when keystrokes can be sent. On refusal, shows a
 * once-per-session notification pointing at the right settings pane.
 * Always true on other platforms.
 */
let _accessibilityNotified = false;
function ensureAccessibilityTrusted() {
    if (process.platform !== 'darwin') return true;
    const trusted = systemPreferences.isTrustedAccessibilityClient(false);
    if (!trusted && !_accessibilityNotified) {
        _accessibilityNotified = true;
        new Notification({
            title: 'Quilly needs Accessibility access',
            body: 'Enable Quilly in System Settings → Privacy & Security → Accessibility so it can copy and paste for you. Until then, use ⌘V to paste manually.',
        }).show();
    }
    return trusted;
}

/**
 * Capture whatever text the user has selected at the moment the hotkey is pressed.
 *
 * CLIP-01: System captures clipboard content when hotkey is pressed.
 * Plain text only — images, files, and rich text are ignored.
 * Keystroke goes through platformUtils (PowerShell SendKeys on Windows,
 * System Events on macOS) — execFile-based, never shell execution.
 *
 * Flow: clear clipboard → send copy keystroke → wait 150ms → read plain text.
 * Returns empty string if nothing is selected or on any error.
 */
async function captureClipboardSelection() {
    // Preserve whatever the user had on the clipboard: if nothing is selected
    // (the common case), the capture must not destroy their existing content.
    // Plain text only — restoring rich content is out of scope.
    const previousClipboardText = clipboard.readText('clipboard') || '';

    // Without Accessibility trust the copy keystroke silently does nothing on
    // macOS — degrade to "no selection" instead of clearing the clipboard.
    if (!ensureAccessibilityTrusted()) {
        return '';
    }

    // Clear clipboard first so we can distinguish fresh selection from stale content
    clipboard.clear();

    try {
        await platformUtils.sendCopyKeystroke();
    } catch (err) {
        console.warn('[captureClipboardSelection] copy keystroke failed:', err.message);
        if (previousClipboardText) clipboard.writeText(previousClipboardText);
        return '';
    }

    // Wait 150ms for the OS clipboard to update.
    // If UAT shows misses on slow machines, upgrade to polling (readText every 20ms up to 200ms).
    await new Promise((resolve) => setTimeout(resolve, 150));

    const captured = clipboard.readText('clipboard') || '';
    if (!captured && previousClipboardText) {
        // Nothing was selected — put the user's original clipboard back.
        clipboard.writeText(previousClipboardText);
    }
    return captured;
}

// IPC handlers
const { ipcMain } = require('electron');

ipcMain.handle('hide-indicator', () => {
    hideIndicator();
});

// The renderer couldn't open the microphone. Clear the stuck bubble and tell
// the user why — most often Windows privacy settings block the microphone
// (e.g. "No" was answered to the microphone prompt in the Store build).
const MIC_SETTINGS_URL = {
    win32: 'ms-settings:privacy-microphone',
    darwin: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
};
ipcMain.handle('recording-start-failed', (event, { name, message } = {}) => {
    const fromIndicator = BrowserWindow.fromWebContents(event.sender) === indicatorWindow;
    if (fromIndicator) hideIndicator();

    const settingsUrl = MIC_SETTINGS_URL[process.platform];
    let title = 'Quilly couldn\'t start recording';
    let body = message || 'The microphone could not be opened.';
    if (name === 'NotAllowedError') {
        title = 'Microphone blocked';
        body = settingsUrl
            ? 'Quilly isn\'t allowed to use the microphone. Click here to open microphone privacy settings and turn Quilly on.'
            : 'Quilly isn\'t allowed to use the microphone. Allow it in your system privacy settings.';
    } else if (name === 'NotFoundError') {
        title = 'No microphone found';
        body = 'Connect a microphone, or choose another one in your sound settings, then try again.';
    }
    const notification = new Notification({ title, body });
    if (name === 'NotAllowedError' && settingsUrl) {
        notification.on('click', () => shell.openExternal(settingsUrl).catch(() => {}));
    }
    notification.show();
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

    try {
        if (reason === 'accepted' && pasteText) {
            // Execute deferred paste
            clipboard.writeText(pasteText);
            setTimeout(() => simulatePaste(), 300);
        }

        // historyData is only set for review-first/analyze popups, where the
        // history entry is deferred until the outcome. Reference popups (OUT-03,
        // default mode) have no pending data — their history was already written.
        if (historyData) {
            // Emit the resolved history to the Dashboard. If the save-first flow
            // already created a placeholder entry (recordingId present), UPDATE it
            // in place so review-first mode doesn't leave an orphaned
            // 'transcribing' entry plus a duplicate. Otherwise add a fresh entry.
            const fields = {
                duration: historyData.duration || '0:00',
                status: 'transcribed',
                transcription: historyData.processedOutput || historyData.rawText,
                rawTranscription: historyData.rawText,
                processedResult: historyData.processedOutput,
                intentLabels: historyData.intentLabels || [],
                audioPath: historyData.audioPath,
            };
            if (!(reason === 'accepted' && pasteText)) {
                // Ghost entry for dismissed or timed_out
                fields.isGhost = true;
                fields.ghostReason = reason; // 'dismissed' or 'timed_out'
            }
            if (mainWindow) {
                if (historyData.recordingId) {
                    safeSend(mainWindow, 'update-recording', { id: historyData.recordingId, updates: fields });
                } else {
                    safeSend(mainWindow, 'add-recording', {
                        name: `Voice Recording ${new Date().toLocaleTimeString()}`,
                        ...fields,
                    });
                }
            }
        }
    } finally {
        // Close popup window — must ALWAYS run. If a throw above skips this, the
        // frameless always-on-top window is stranded on screen as a black box
        // (its content has already slid out to opacity 0) with no way to dismiss.
        if (reviewPopupWindow && !reviewPopupWindow.isDestroyed()) {
            reviewPopupWindow.close();
        }
    }

    return { success: true };
});

ipcMain.handle('transcription-complete', async (event, { text, x, y, audioData, audioPath: ipcAudioPath, recordingId, duration: ipcDuration, editorMode, editorContent, editorInstruction }) => {
    console.log('Transcription complete:', text);

    // Strip Whisper non-speech artifacts ([BLANK_AUDIO], [Music], ...) once, up
    // front, so they never reach intent routing, the LLM, or the pasted text.
    // (Previously only the final-cleanup path stripped them.)
    text = liveLlmService.stripWhisperArtifacts(String(text || ''));

    // Silence-only recordings strip to nothing. Bail out here — the normal path
    // would overwrite the user's clipboard with '' and simulate a paste of nothing.
    if (!text.trim()) {
        console.log('[transcription-complete] Empty transcription after artifact strip — nothing to paste');
        pendingClipboardText = '';
        pendingLlmMode = false;
        if (!editorMode) {
            hideIndicator();
            setTimeout(() => {
                whisperService.dispose().catch(e => console.error('Failed to dispose model:', e));
            }, 500);
        }
        return {
            success: true,
            pastedText: '',
            rawText: '',
            llmProcessed: false,
            finalCleanupApplied: false,
            finalCleanupSummary: null,
            processedResult: null,
            intent: null,
            intentLabel: null,
            intentLabels: [],
            shouldBlockPaste: false,
            emptyTranscription: true,
        };
    }

    // AUTO-DIARIZE: background speaker detection for the new history entry.
    // Fire-and-forget — must never delay the paste path. Serialized through
    // the diarize chain like manual runs. Skipped (with a log) when the
    // engine isn't installed: downloads happen only from the explicit UI
    // consent flow, never silently.
    if (!editorMode && recordingId && audioData) {
        (async () => {
            try {
                const store = await getSettingsStore();
                if (!store.get('autoDiarizeEnabled', false)) return;
                if (!sherpaDownloader.isInstalled()) {
                    console.log('[diarize] auto-diarize skipped — engine not installed');
                    return;
                }
                const res = await enqueueDiarizeJob(audioData, null);
                if (res.success) {
                    safeSend(mainWindow, 'update-recording', {
                        id: recordingId,
                        updates: {
                            diarization: {
                                segments: res.segments,
                                speakerNames: defaultSpeakerNames(res.segments),
                                numSpeakersRequested: null,
                                createdAt: new Date().toISOString(),
                            },
                        },
                    });
                } else {
                    console.warn('[diarize] auto-diarize failed:', res.error);
                }
            } catch (e) {
                console.warn('[diarize] auto-diarize error:', e.message);
            }
        })();
    }

    const capturedClipboard = pendingClipboardText;
    // Reset pendingClipboardText immediately — prevent stale clipboard leaks
    pendingClipboardText = '';

    let textToPaste = text;
    let didRunLlm = false;
    let processedOutput = null;
    let finalCleanupApplied = false;
    let finalCleanupSummary = null;
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
            routeResult = {
                wakeWordFound: true,
                intent: 'freeform',
                content: text.trim(),
                rawInstruction: text.trim(),
                targetLanguage: null,
            };
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
            } else if (pref === '35b') {
                neededModelKey = 'qwen3.6-35b-a3b';
            } else {
                // Auto: prefer 9B, fall back to 4B.
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
                // Model is available — check the llama-server runtime WITHOUT
                // blocking the dictation. On upgrade days (a PINNED_TAG bump)
                // the binary download is hundreds of MB; the user's words must
                // not hang behind it (observed live 2026-07-02: LLM dictation
                // froze on the indicator for the whole download).
                const useCudaForLlm = await shouldUseCudaForLlm(llmStore);
                const runtimeReady = { success: llamaDownloader.isBinaryCompatibleWithMode?.(useCudaForLlm) === true };

                if (!runtimeReady.success) {
                    console.log('[transcription-complete] llama-server runtime not ready (missing or outdated) — pasting raw text; upgrading in background');
                    ensureLlamaBinaryForMode(llmStore, event.sender)
                        .then(() => console.log('[main] LLM runtime ready (background upgrade complete)'))
                        .catch((err) => console.error('[main] Background LLM runtime upgrade failed:', err.message));
                    sendLlmStatus('idle', { errorType: 'binary-updating' });
                    textToPaste = text;
                    new Notification({
                        title: 'Quilly',
                        body: 'The AI engine is updating in the background. Raw transcription pasted — try AI processing again in a few minutes.',
                    }).show();
                } else {
                sendLlmStatus('processing');
                // VRAM-01/02: inform llamaService of the last Whisper subprocess PID so
                // ensureWhisperUnloaded() can confirm the process is dead before loading LLM.
                if (_lastWhisperCppPid) {
                    llamaService.setWhisperPid(_lastWhisperCppPid);
                }
                try {
                    let result;
                    const developerPromptConfig = getActiveDeveloperPromptConfig(llmStore);
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
                        result = await pipeline.processChainedText(text, chainResults, capturedClipboard, { onStepStart, developerPromptConfig });
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
                        const selectedWhisperModel = llmStore.get('whisperModel');
                        const selectedWhisperLanguage = llmStore.get('whisperLanguage', 'auto');
                        const whisperPipelineOptions = { modelId: selectedWhisperModel, developerPromptConfig };
                        if (
                            selectedWhisperModel &&
                            !selectedWhisperModel.endsWith('.en') &&
                            selectedWhisperLanguage &&
                            selectedWhisperLanguage !== 'auto'
                        ) {
                            whisperPipelineOptions.language = selectedWhisperLanguage;
                        }

                        if (
                            audioData &&
                            routeResult.intent === 'translate' &&
                            routeResult.targetLanguage &&
                            routeResult.targetLanguage.toLowerCase() === 'english' &&
                            !capturedClipboard
                        ) {
                            // PROC-06: use processRecording so Whisper --translate mode is available.
                            // processRecording will re-transcribe via whisperCppService and apply the
                            // translate-to-English guard at Step 4 — no LLM invocation needed.
                            result = await pipeline.processRecording(audioData, capturedClipboard, whisperPipelineOptions);
                        } else {
                            const pipelineOpts = llmMode
                                ? { routeOverride: routeResult, developerPromptConfig }
                                : (editorContent && editorInstruction)
                                    ? { routeOverride: routeResult, editorInstruction, developerPromptConfig }
                                    : { developerPromptConfig };
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
        } else {
            const cleanupStore = await getSettingsStore();
            const cleanupResult = await runFinalTranscriptCleanup(text, cleanupStore, event.sender);
            if (cleanupResult?.text) {
                textToPaste = cleanupResult.text;
                finalCleanupApplied = true;
                finalCleanupSummary = cleanupResult.editSummary || 'final cleanup';
                console.log(`[transcription-complete] Final cleanup applied: model=${cleanupResult.modelId || 'auto'} format=${cleanupResult.responseFormat || 'unknown'} summary=${finalCleanupSummary}`);
            }
        }
        // If transcribe mode and final cleanup is disabled/unavailable: textToPaste remains the full Whisper text.
    } catch (routeErr) {
        console.error('[transcription-complete] Intent routing failed, pasting raw text:', routeErr.message);
        textToPaste = text;
        finalCleanupApplied = false;
        finalCleanupSummary = null;
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
                // save-first: the Indicator already created a placeholder entry
                // for this recording. Reuse it on outcome so we don't duplicate.
                recordingId: recordingId || null,
                duration: ipcDuration || null,
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
        finalCleanupApplied,
        finalCleanupSummary,
        processedResult: processedOutput,
        intent: capturedIntent,
        intentLabel: intentLabel,
        intentLabels: intentLabels,
        shouldBlockPaste: !!shouldBlockPaste,
    };
});

function simulatePaste() {
    // The text is already on the clipboard; if the paste keystroke can't be
    // sent (e.g. macOS Accessibility not granted), the user can still ⌘V/Ctrl+V
    // manually — the notification from ensureAccessibilityTrusted explains that.
    if (!ensureAccessibilityTrusted()) {
        return;
    }
    platformUtils.sendPasteKeystroke();
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

// True when running as the Microsoft Store (MSIX) package.
ipcMain.handle('app-is-windows-store', () => process.windowsStore === true);

ipcMain.handle('app-info', () => ({
    version: app.getVersion(),
    isWindowsStore: process.windowsStore === true,
    platform: process.platform,
}));

// ─── Update check (GitHub installer build only) ──────────────────────────────
// The Store build is updated by Windows, and Store policy forbids self-updates,
// so it never contacts GitHub for releases.
async function runUpdateCheck() {
    if (process.windowsStore) return { status: 'store', currentVersion: app.getVersion() };
    const result = await updateChecker.checkForUpdates({ currentVersion: app.getVersion(), fetchImpl: (url, opts) => net.fetch(url, opts) });
    if (result.status !== 'error') {
        const store = await getSettingsStore();
        store.set('lastUpdateCheckAt', Date.now());
    }
    return result;
}

ipcMain.handle('update-check', () => runUpdateCheck());

function scheduleAutoUpdateCheck() {
    if (process.windowsStore || isDev) return;
    setTimeout(async () => {
        try {
            const store = await getSettingsStore();
            if (!store.get('autoUpdateCheck', true)) return;
            if (!updateChecker.isCheckDue(store.get('lastUpdateCheckAt'))) return;
            const result = await runUpdateCheck();
            if (result.status !== 'available') return;
            const notification = new Notification({
                title: `Quilly ${result.latestVersion} is available`,
                body: `You have ${result.currentVersion}. Click to open the download page.`,
            });
            notification.on('click', () => shell.openExternal(result.url).catch(() => {}));
            notification.show();
        } catch (err) {
            console.warn('[update-check] automatic check failed:', err.message);
        }
    }, 30 * 1000);
}

ipcMain.handle('save-to-history', async (event, recording) => {
    if (mainWindow) {
        safeSend(mainWindow, 'add-recording', recording);
        return { success: true };
    }
    return { success: false, error: 'Main window not available' };
});

// Update an existing history entry (deferred fill-in after save-first recording).
// Mirrors save-to-history: the store lives in the Dashboard renderer, so we
// forward the patch and let storageService.update apply it.
ipcMain.handle('update-recording', async (event, id, updates) => {
    if (mainWindow) {
        safeSend(mainWindow, 'update-recording', { id, updates });
        return { success: true };
    }
    return { success: false, error: 'Main window not available' };
});

// Whisper transcription
const whisperService = require('./whisperService.cjs');
const whisperCppService = require('./whisperCppService.cjs');
const whisperCppDownloader = require('./whisperCppDownloader.cjs');
const gpuDetector = require('./gpuDetector.cjs');

// ─── Speaker diarization (sherpa-onnx sidecar) ──────────────────────────────
const sherpaDownloader = require('./sherpaDownloader.cjs');
const diarizationService = require('./diarizationService.cjs');
const { mergeTranscriptWithTurns, defaultSpeakerNames } = require('./diarizationMerge.cjs');

// One diarization at a time — the job is CPU-heavy (whisper + sherpa in
// parallel); concurrent jobs would thrash. Same chaining pattern as
// llamaDownloader.downloadBinary.
let _diarizeChain = Promise.resolve();

const enqueueDiarizeJob = (audioData, numSpeakers) => {
    const job = _diarizeChain.then(() => runDiarizationJob(audioData, numSpeakers));
    _diarizeChain = job.then(() => {}, () => {});
    return job;
};

// The diarize transcription pass never uses Parakeet: parakeet-cli emits no
// timestamps, and alignment is impossible without them. Fall back to any
// installed whisper model when the configured engine is Parakeet.
const pickWhisperModelForDiarization = async () => {
    const store = await getSettingsStore();
    const configured = store.get('whisperModel', 'Xenova/whisper-small');
    if (!whisperCppService.isParakeetModel(configured) && whisperCppService.findModel(configured)) {
        return configured;
    }
    const fallbacks = [
        'Xenova/whisper-small',
        'Xenova/whisper-base',
        'onnx-community/whisper-large-v3-turbo',
        'Xenova/whisper-medium',
        'Xenova/whisper-large-v3',
    ];
    return fallbacks.find(id => whisperCppService.findModel(id)) || null;
};

const runDiarizationJob = async (audioData, numSpeakers) => {
    const modelId = await pickWhisperModelForDiarization();
    if (!modelId) {
        return {
            success: false,
            error: 'Speaker detection needs a Whisper model installed (Parakeet does not produce timestamps). Add one in Settings.',
        };
    }

    const floatArray = audioData instanceof Float32Array ? audioData
        : Array.isArray(audioData) ? new Float32Array(audioData)
            : new Float32Array(Object.values(audioData));
    const durationSecs = floatArray.length / 16000;
    const store = await getSettingsStore();
    const language = store.get('whisperLanguage') || 'auto';

    // Sherpa reads a WAV file; whisper writes its own temp WAV internally.
    const wavPath = path.join(app.getPath('temp'), `diarize-${process.pid}-${Date.now()}.wav`);
    fs.writeFileSync(wavPath, whisperCppService.float32ToWav(floatArray));
    try {
        const [whisperRes, diarRes] = await Promise.all([
            whisperCppService.transcribe(floatArray, { modelId, language, timestamps: true }),
            diarizationService.diarize(wavPath, { numSpeakers, durationSecs }),
        ]);
        if (!diarRes.success) return { success: false, error: diarRes.error };
        if (!whisperRes.success || !whisperRes.text) return { success: false, error: 'No speech detected' };
        if (!diarRes.turns.length) return { success: false, error: 'No speakers detected in this recording' };
        const segments = mergeTranscriptWithTurns(whisperRes.segments, diarRes.turns);
        if (!segments.length) return { success: false, error: 'No speech detected' };
        return { success: true, segments };
    } catch (e) {
        return { success: false, error: e.message };
    } finally {
        try { fs.unlinkSync(wavPath); } catch (_) { /* ignore */ }
    }
};

ipcMain.handle('diarize:status', () => ({ installed: sherpaDownloader.isInstalled() }));

ipcMain.handle('diarize:setup', async () => {
    try {
        await sherpaDownloader.setup((progress) => {
            safeSend(mainWindow, 'diarize:setup-progress', progress);
        });
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('diarize:run', (event, audioData, numSpeakers = null) => {
    return enqueueDiarizeJob(audioData, numSpeakers);
});

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
    // Surface engine failures as a system notification — the floating indicator
    // can only flash a brief ✕, and a silent failure cost real debugging time
    // when the Parakeet engine was missing.
    if (result && result.success === false && result.error) {
        new Notification({ title: 'Quilly — transcription failed', body: result.error }).show();
    }
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
    const developerConfig = promptConfig.getDeveloperConfigFromStore(store);
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
        wakeWord: store.get('wakeWord', 'quilly'),
        hotkeyTranscribe: store.get('hotkeyTranscribe', 'CommandOrControl+Alt+V'),
        hotkeyLlm: store.get('hotkeyLlm', 'CommandOrControl+Alt+P'),
        finalTranscriptCleanupEnabled: store.get('finalTranscriptCleanupEnabled', false),
        autoDiarizeEnabled: store.get('autoDiarizeEnabled', false),
        autoUpdateCheck: store.get('autoUpdateCheck', true),
        developerSettingsEnabled: developerConfig.enabled,
        activePromptProfileId: developerConfig.activeProfileId,
    };
});

const ALLOWED_SETTING_KEYS = ['whisperModel', 'whisperLanguage', 'firstRunComplete', 'autoLaunch', 'whisperCppEnabled', 'llmFirstUsePromptDismissed', 'llmEnabled', 'llmGpuMode', 'reviewFirstMode', 'llmModelPreference', 'wakeWord', 'hotkeyTranscribe', 'hotkeyLlm', 'finalTranscriptCleanupEnabled', 'autoDiarizeEnabled', 'autoUpdateCheck', 'developerSettingsEnabled', 'activePromptProfileId'];

// Wake words must be a single word of 2-32 letters (any script). Letters ONLY:
// intentRouter.tokenize() strips non-letters from token edges, so a wake word
// containing digits/hyphens (e.g. "r2d2") would validate here but could never
// match a spoken token. Multi-word phrases can never match either (the router
// compares single tokens).
const WAKE_WORD_PATTERN = /^\p{L}{2,32}$/u;

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
    if ((key === 'finalTranscriptCleanupEnabled' || key === 'developerSettingsEnabled' || key === 'autoUpdateCheck') && typeof value !== 'boolean') {
        return { success: false, error: 'Setting must be boolean' };
    }
    if (key === 'wakeWord') {
        if (typeof value !== 'string' || !WAKE_WORD_PATTERN.test(value.trim())) {
            return { success: false, error: 'Wake word must be a single word (2-32 letters)' };
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
    // Propagate wake word to the router and to Whisper's recognition bias
    if (key === 'wakeWord') {
        intentRouter.setWakeWord(value);
        whisperCppService.setWhisperPrompt(value);
    }
    // Re-register global shortcuts when hotkeys change
    if (key === 'hotkeyTranscribe' || key === 'hotkeyLlm') {
        reregisterGlobalShortcuts();
    }
    return { success: true };
});

ipcMain.handle('developer-config:get', async () => {
    const store = await getSettingsStore();
    return promptConfig.getDeveloperConfigFromStore(store);
});

ipcMain.handle('developer-config:save', async (event, config = {}) => {
    const store = await getSettingsStore();
    return promptConfig.saveDeveloperConfigToStore(store, config);
});

ipcMain.handle('developer-config:reset-active', async (event, { profileId } = {}) => {
    const store = await getSettingsStore();
    const config = promptConfig.getDeveloperConfigFromStore(store);
    const targetId = profileId || config.activeProfileId;
    if (targetId === promptConfig.INSTALLED_PROFILE_ID) {
        return config;
    }

    const installed = promptConfig.createInstalledProfile();
    const profiles = config.profiles.map((profile) => {
        if (profile.id !== targetId) return profile;
        return {
            ...installed,
            id: profile.id,
            name: profile.name,
            isInstalled: false,
            locked: false,
        };
    });
    return promptConfig.saveDeveloperConfigToStore(store, {
        ...config,
        profiles,
        activeProfileId: targetId,
    });
});

ipcMain.handle('developer-config:set-active', async (event, { profileId } = {}) => {
    const store = await getSettingsStore();
    const config = promptConfig.getDeveloperConfigFromStore(store);
    const targetId = typeof profileId === 'string' ? profileId : promptConfig.INSTALLED_PROFILE_ID;
    const activeProfileId = config.profiles.some(profile => profile.id === targetId)
        ? targetId
        : promptConfig.INSTALLED_PROFILE_ID;

    store.set('activePromptProfileId', activeProfileId);
    return promptConfig.getDeveloperConfigFromStore(store);
});

ipcMain.handle('developer-config:test-final-cleanup', async (event, { text, profile } = {}) => {
    const store = await getSettingsStore();
    const result = await runFinalTranscriptCleanup(text, store, event.sender, {
        force: true,
        includeDiagnostics: true,
        profile,
    });
    return {
        success: true,
        cleanup: result.cleanup,
        diagnostics: result.diagnostics,
    };
});

ipcMain.handle('developer-config:test-freeform', async (event, { text, profile } = {}) => {
    const rawText = String(text || '').trim();
    if (!rawText) {
        return { success: false, error: 'Test input is empty' };
    }

    const store = await getSettingsStore();
    const developerPromptConfig = {
        enabled: true,
        ...promptConfig.sanitizeProfile(profile),
    };
    const routeOverride = {
        wakeWordFound: true,
        intent: 'freeform',
        content: rawText,
        rawInstruction: rawText,
        targetLanguage: null,
    };

    try {
        await ensureLlamaBinaryForMode(store, event.sender);
        const result = await pipeline.processTranscribedText(rawText, null, {
            routeOverride,
            developerPromptConfig,
        });
        return {
            success: true,
            result,
            diagnostics: {
                input: rawText,
                output: result.output,
                intent: result.intent,
            },
        };
    } catch (err) {
        return { success: false, error: err.message };
    }
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
    const tempDir = getRecordingsDir();
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
        // Restrict source path to the recordings dir or OS temp (temp kept for
        // backward compatibility with entries saved before the recordings dir).
        const allowedRoots = [path.resolve(getRecordingsDir()), path.resolve(app.getPath('temp'))];
        const resolvedSource = path.resolve(sourcePath);
        const allowed = allowedRoots.some(root => resolvedSource === root || resolvedSource.startsWith(root + path.sep));
        if (!allowed) {
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
        // Restrict reads to the recordings dir or OS temp (temp kept for
        // backward compatibility with older entries).
        const allowedRoots = [path.resolve(getRecordingsDir()), path.resolve(app.getPath('temp'))];
        const resolvedPath = path.resolve(filePath);
        const allowed = allowedRoots.some(root => resolvedPath === root || resolvedPath.startsWith(root + path.sep));
        if (!allowed) {
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

// Delete a recording's audio when its history entry is deleted, so "delete"
// really removes the audio from disk. Same allowed roots as read-audio-file.
ipcMain.handle('delete-audio-file', async (event, filePath) => {
    try {
        const allowedRoots = [path.resolve(getRecordingsDir()), path.resolve(app.getPath('temp'))];
        const resolvedPath = path.resolve(String(filePath || ''));
        const allowed = allowedRoots.some(root => resolvedPath.startsWith(root + path.sep));
        if (!allowed) {
            return { success: false, error: 'Access denied: path outside allowed directory' };
        }
        if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
            fs.unlinkSync(resolvedPath);
        }
        return { success: true };
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
        // Download binary if needed (or if switching backends). Parakeet models
        // additionally need parakeet-cli.exe, which older whisper.cpp installs
        // don't have — re-running setup fetches the pinned release that does.
        const currentBackend = whisperCppService.getStatus(targetModel).installedBackend;
        const needsBinary = !whisperCppService.findBinary()
            || (backend && backend !== currentBackend)
            || (whisperCppService.isParakeetModel(targetModel) && !whisperCppService.findParakeetBinary());

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

        // Setup must not report success for a Parakeet target unless the
        // Parakeet engine actually landed — downloadBinary only verifies
        // whisper-cli.exe exists after extraction.
        if (whisperCppService.isParakeetModel(targetModel) && !whisperCppService.findParakeetBinary()) {
            return {
                success: false,
                error: 'The installed whisper.cpp package does not include the Parakeet engine (parakeet-cli.exe). Try setup again or choose a Whisper model.',
                ...results,
            };
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

    // RAM gate for oversized models (the 35B MoE needs ~23GB free to load) —
    // refuse the 21GB download on machines that could never run it.
    const minRamGB = modelRegistry.REGISTRY[modelId]?.minTotalRamGB;
    if (minRamGB && os.totalmem() < minRamGB * 1024 * 1024 * 1024) {
        const totalGB = Math.round(os.totalmem() / (1024 ** 3));
        return Promise.resolve({
            success: false,
            error: `This model needs a machine with at least ${minRamGB + 4} GB of RAM (this system has ${totalGB} GB).`,
        });
    }

    // Create a cancel token for this download. `cancelled` is the persistent
    // flag — it works even while the task is still queued behind another
    // download and token.cancel has not been wired yet.
    const cancelToken = { cancel: null, cancelled: false };
    _cancelTokens[modelId] = cancelToken;

    // Enqueue download — serializes against other downloads
    const task = _downloadQueue.then(async () => {
        // Cancelled (or deleted) while waiting in the queue — do not start.
        // Clean up the token here too: this early return skips the finally
        // below, and a stale token would make later cancel calls report
        // success for a download that no longer exists.
        if (cancelToken.cancelled) {
            if (_cancelTokens[modelId] === cancelToken) {
                delete _cancelTokens[modelId];
            }
            return { success: false, error: 'Download cancelled' };
        }
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
    _downloadTasks[modelId] = task;
    task.finally(() => {
        if (_downloadTasks[modelId] === task) delete _downloadTasks[modelId];
    }).catch(() => {});

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
    if (token) {
        // The flag alone is enough for queued/connecting phases; the cancel()
        // function (when wired by downloadFile) additionally aborts the active
        // socket immediately.
        token.cancelled = true;
        if (typeof token.cancel === 'function') {
            token.cancel();
        }
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
        // If this model is being downloaded (active OR still queued), cancel it
        // and wait for ITS task to settle — unlinking a .partial with an open
        // write handle on Windows leaves a delete-pending file the still-running
        // download keeps feeding, and a queued task would re-download the model
        // right after this delete "succeeded". Awaiting only this model's task
        // (not the whole queue) keeps the delete from blocking behind unrelated
        // multi-GB downloads.
        const token = _cancelTokens[modelId];
        if (token) {
            token.cancelled = true;
            if (typeof token.cancel === 'function') {
                token.cancel();
            }
        }
        const pendingTask = _downloadTasks[modelId];
        if (pendingTask) {
            await pendingTask.catch(() => {});
        }

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
