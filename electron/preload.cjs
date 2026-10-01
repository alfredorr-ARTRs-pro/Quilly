const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Indicator controls
    hideIndicator: () => ipcRenderer.invoke('hide-indicator'),
    recordingStartFailed: (name, message) => ipcRenderer.invoke('recording-start-failed', { name, message }),
    pasteText: (text) => ipcRenderer.invoke('paste-text', text),
    transcriptionComplete: (text, x, y, audioData, audioPath, options) => ipcRenderer.invoke('transcription-complete', { text, x, y, audioData, audioPath, ...options }),

    // Window info
    getWindowType: () => ipcRenderer.invoke('get-window-type'),
    isWindowsStore: () => ipcRenderer.invoke('app-is-windows-store'),
    getAppInfo: () => ipcRenderer.invoke('app-info'),
    checkForUpdates: () => ipcRenderer.invoke('update-check'),

    // Whisper transcription
    transcribe: (audioPath, options) => ipcRenderer.invoke('whisper-transcribe', audioPath, options),
    modelExists: (modelName) => ipcRenderer.invoke('whisper-model-exists', modelName),
    downloadModel: (modelName) => ipcRenderer.invoke('whisper-download-model', modelName),
    getModelPath: () => ipcRenderer.invoke('whisper-get-model-path'),

    // Settings
    getSettings: () => ipcRenderer.invoke('settings-get'),
    setSetting: (key, value) => ipcRenderer.invoke('settings-set', key, value),
    developerConfigGet: () => ipcRenderer.invoke('developer-config:get'),
    developerConfigSave: (config) => ipcRenderer.invoke('developer-config:save', config),
    developerConfigSetActive: (profileId) => ipcRenderer.invoke('developer-config:set-active', { profileId }),
    developerConfigResetActive: (profileId) => ipcRenderer.invoke('developer-config:reset-active', { profileId }),
    developerConfigTestFinalCleanup: (payload) => ipcRenderer.invoke('developer-config:test-final-cleanup', payload),
    developerConfigTestFreeform: (payload) => ipcRenderer.invoke('developer-config:test-freeform', payload),

    // Auto-launch (start with Windows)
    getAutoLaunch: () => ipcRenderer.invoke('auto-launch-get'),
    setAutoLaunch: (enabled) => ipcRenderer.invoke('auto-launch-set', enabled),

    // Model management
    getAvailableModels: () => ipcRenderer.invoke('get-available-models'),
    changeWhisperModel: (modelId) => ipcRenderer.invoke('whisper-change-model', modelId),
    preloadModel: (modelId) => ipcRenderer.invoke('whisper-preload-model', modelId),
    getCurrentModel: () => ipcRenderer.invoke('whisper-get-current-model'),

    // Audio file handling
    saveAudioTemp: (arrayBuffer, filename) => ipcRenderer.invoke('save-audio-temp', arrayBuffer, filename),
    saveAudioFile: (sourcePath) => ipcRenderer.invoke('save-audio-file', sourcePath),
    readAudioFile: (filePath) => ipcRenderer.invoke('read-audio-file', filePath),
    deleteAudioFile: (filePath) => ipcRenderer.invoke('delete-audio-file', filePath),

    // Save transcription to history
    saveToHistory: (recording) => ipcRenderer.invoke('save-to-history', recording),

    // GPU detection & whisper.cpp backend
    detectGpu: () => ipcRenderer.invoke('gpu-detect'),
    whisperCppStatus: () => ipcRenderer.invoke('whisper-cpp-status'),
    whisperCppSetup: (options) => ipcRenderer.invoke('whisper-cpp-setup', options),
    onWhisperCppProgress: (callback) => {
        const handler = (_event, progress) => callback(progress);
        ipcRenderer.on('whisper-cpp-progress', handler);
        return () => ipcRenderer.removeListener('whisper-cpp-progress', handler);
    },

    // Speaker diarization
    diarizeStatus: () => ipcRenderer.invoke('diarize:status'),
    diarizeSetup: () => ipcRenderer.invoke('diarize:setup'),
    diarizeRun: (audioArray, numSpeakers) => ipcRenderer.invoke('diarize:run', audioArray, numSpeakers),
    onDiarizeSetupProgress: (callback) => {
        const handler = (_event, progress) => callback(progress);
        ipcRenderer.on('diarize:setup-progress', handler);
        return () => ipcRenderer.removeListener('diarize:setup-progress', handler);
    },

    // LLM model management
    llmGetModelStatus: () => ipcRenderer.invoke('llm:get-model-status'),
    llmDownloadModel: (modelId) => ipcRenderer.invoke('llm:download-model', { modelId }),
    llmDownloadBinary: () => ipcRenderer.invoke('llm:download-binary'),
    llmCancelDownload: (modelId) => ipcRenderer.invoke('llm:cancel-download', { modelId }),
    llmDeleteModel: (modelId) => ipcRenderer.invoke('llm:delete-model', { modelId }),
    llmGetServerStatus: () => ipcRenderer.invoke('llm:get-server-status'),
    onLlmStatus: (callback) => {
        const handler = (_event, payload) => callback(payload);
        ipcRenderer.on('llm:status', handler);
        return () => ipcRenderer.removeListener('llm:status', handler);
    },
    onLlmDownloadProgress: (callback) => {
        const handler = (_event, payload) => callback(payload);
        ipcRenderer.on('llm:download-progress', handler);
        return () => ipcRenderer.removeListener('llm:download-progress', handler);
    },
    // UI-03: First-use prompt bridge
    onLlmFirstUsePrompt: (callback) => {
        const handler = (_event, payload) => callback(payload);
        ipcRenderer.on('llm:first-use-prompt', handler);
        return () => ipcRenderer.removeListener('llm:first-use-prompt', handler);
    },
    // UI-05: Deep-link — open SettingsModal scrolled to LLM section
    onLlmOpenSettingsLlm: (callback) => {
        const handler = (_event) => callback();
        ipcRenderer.on('llm:open-settings-llm', handler);
        return () => ipcRenderer.removeListener('llm:open-settings-llm', handler);
    },
    llmOpenSetup: () => ipcRenderer.invoke('llm:open-setup'),
    llmSetIndicatorInteractive: (interactive) => ipcRenderer.invoke('llm:set-indicator-interactive', interactive),
    llmSetGpuMode: (mode) => ipcRenderer.invoke('llm:set-gpu-mode', mode),
    llmCheckActive: () => ipcRenderer.invoke('llm:check-active'),

    // Events from main process
    onRecordingComplete: (callback) => {
        const handler = (_event, ...args) => callback(...args);
        ipcRenderer.on('recording-complete', handler);
        return () => ipcRenderer.removeListener('recording-complete', handler);
    },
    onTranscriptionProgress: (callback) => {
        const handler = (_event, ...args) => callback(...args);
        ipcRenderer.on('transcription-progress', handler);
        return () => ipcRenderer.removeListener('transcription-progress', handler);
    },
    onAddRecording: (callback) => {
        const handler = (_event, recording) => callback(recording);
        ipcRenderer.on('add-recording', handler);
        return () => ipcRenderer.removeListener('add-recording', handler);
    },
    updateRecording: (id, updates) => ipcRenderer.invoke('update-recording', id, updates),
    onUpdateRecording: (callback) => {
        const handler = (_event, payload) => callback(payload);
        ipcRenderer.on('update-recording', handler);
        return () => ipcRenderer.removeListener('update-recording', handler);
    },

    // Recording control events from main process
    onStartRecording: (callback) => {
        const handler = () => callback();
        ipcRenderer.on('start-recording', handler);
        return () => ipcRenderer.removeListener('start-recording', handler);
    },
    onStopRecording: (callback) => {
        const handler = (_event, coords) => callback(coords);
        ipcRenderer.on('stop-recording', handler);
        return () => ipcRenderer.removeListener('stop-recording', handler);
    },
    onResetIndicator: (callback) => {
        const handler = () => callback();
        ipcRenderer.on('reset-indicator', handler);
        return () => ipcRenderer.removeListener('reset-indicator', handler);
    },

    // Review popup bridge
    onReviewPopupShow: (handler) => {
        const wrapped = (_event, data) => handler(data);
        ipcRenderer.on('review-popup:show', wrapped);
        return () => ipcRenderer.removeListener('review-popup:show', wrapped);
    },
    reviewPopupOutcome: (reason) => ipcRenderer.invoke('review-popup:outcome', { reason }),
    reviewPopupCopyToClipboard: (text) => ipcRenderer.invoke('review-popup:copy', text),

});
