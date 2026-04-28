import { useState, useEffect, useRef } from 'react';
import './SettingsModal.css';
import LlmSettingsSection from './LlmSettingsSection';

const LANGUAGE_OPTIONS = [
    { code: 'auto', label: 'Auto-detect' },
    { code: 'en', label: 'English' },
    { code: 'es', label: 'Spanish' },
    { code: 'fr', label: 'French' },
    { code: 'de', label: 'German' },
    { code: 'it', label: 'Italian' },
    { code: 'pt', label: 'Portuguese' },
    { code: 'nl', label: 'Dutch' },
    { code: 'ru', label: 'Russian' },
    { code: 'zh', label: 'Chinese' },
    { code: 'ja', label: 'Japanese' },
    { code: 'ko', label: 'Korean' },
    { code: 'ar', label: 'Arabic' },
    { code: 'hi', label: 'Hindi' },
    { code: 'tr', label: 'Turkish' },
    { code: 'pl', label: 'Polish' },
    { code: 'uk', label: 'Ukrainian' },
    { code: 'sv', label: 'Swedish' },
    { code: 'da', label: 'Danish' },
    { code: 'no', label: 'Norwegian' },
    { code: 'fi', label: 'Finnish' },
    { code: 'cs', label: 'Czech' },
    { code: 'ro', label: 'Romanian' },
    { code: 'hu', label: 'Hungarian' },
    { code: 'el', label: 'Greek' },
    { code: 'he', label: 'Hebrew' },
    { code: 'th', label: 'Thai' },
    { code: 'vi', label: 'Vietnamese' },
    { code: 'id', label: 'Indonesian' },
    { code: 'ms', label: 'Malay' },
    { code: 'tl', label: 'Filipino (Tagalog)' },
];

// Backend display labels
const BACKEND_LABELS = {
    cuda12: 'CUDA 12',
    cuda11: 'CUDA 11',
    vulkan: 'Vulkan',
    openblas: 'CPU Accelerated (OpenBLAS)',
    cpu: 'Basic CPU',
};

function SettingsModal({ isOpen, onClose, deepLinkLlm, onDeepLinkConsumed }) {
    const [models, setModels] = useState([]);
    const [currentModel, setCurrentModel] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);
    const [currentLanguage, setCurrentLanguage] = useState('auto');

    // LLM settings state
    const [llmEnabled, setLlmEnabled] = useState(true);
    const [llmGpuMode, setLlmGpuMode] = useState('auto');
    const [llmServerRunning, setLlmServerRunning] = useState(false);
    // LLM model download manager state
    const [llmModels, setLlmModels] = useState({});
    // OUT-02: Review-first mode toggle
    const [reviewFirstMode, setReviewFirstMode] = useState(false);
    // Model preference: 'auto', '4b', '9b'
    const [llmModelPreference, setLlmModelPreference] = useState('auto');
    // Hotkeys
    const [hotkeyTranscribe, setHotkeyTranscribe] = useState('CommandOrControl+Alt+V');
    const [hotkeyLlm, setHotkeyLlm] = useState('CommandOrControl+Alt+P');
    const [hotkeyRecording, setHotkeyRecording] = useState(null); // which hotkey is currently being recorded
    const [hotkeyError, setHotkeyError] = useState(null);

    // GPU detection & backend state
    const [gpuInfo, setGpuInfo] = useState(null);
    const [gpuDetecting, setGpuDetecting] = useState(false);
    const [cppStatus, setCppStatus] = useState(null);
    const [selectedBackend, setSelectedBackend] = useState(null);
    const [cppSetupRunning, setCppSetupRunning] = useState(false);
    const [cppProgress, setCppProgress] = useState(null);

    // UI-05: Deep-link ref and highlight state for LLM section scroll
    const llmSectionRef = useRef(null);
    const [highlightLlm, setHighlightLlm] = useState(false);

    useEffect(() => {
        if (isOpen) {
            loadSettings();
        }
    }, [isOpen]);

    // UI-05: Scroll to LLM section and show highlight when deep-link flag is set
    useEffect(() => {
        if (!isOpen || !deepLinkLlm) return;
        // Small delay to allow modal to render and settings to load
        const timer = setTimeout(() => {
            if (llmSectionRef.current) {
                llmSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            setHighlightLlm(true);
            // Clear highlight after 3 seconds
            const fadeTimer = setTimeout(() => setHighlightLlm(false), 3000);
            // Consume the deep-link flag so reopening modal does not re-trigger
            onDeepLinkConsumed?.();
            return () => clearTimeout(fadeTimer);
        }, 300);
        return () => clearTimeout(timer);
    }, [isOpen, deepLinkLlm, onDeepLinkConsumed]);

    // Listen for download progress events
    useEffect(() => {
        if (!window.electronAPI?.onWhisperCppProgress) return;
        const unsub = window.electronAPI.onWhisperCppProgress((progress) => {
            setCppProgress(progress);
        });
        return () => unsub?.();
    }, []);

    const loadSettings = async () => {
        try {
            setGpuDetecting(true);
            const [availableModels, settings, gpuStatus, gpu, serverStatus, modelStatus] = await Promise.all([
                window.electronAPI.getAvailableModels(),
                window.electronAPI.getSettings(),
                window.electronAPI.whisperCppStatus?.() || Promise.resolve(null),
                window.electronAPI.detectGpu?.() || Promise.resolve(null),
                window.electronAPI.llmGetServerStatus?.() || Promise.resolve(null),
                window.electronAPI.llmGetModelStatus?.() || Promise.resolve({}),
            ]);
            setModels(availableModels);
            setCurrentModel(settings.whisperModel);
            setCurrentLanguage(settings.whisperLanguage || 'auto');
            setCppStatus(gpuStatus);
            setGpuInfo(gpu);
            // Default selected backend to installed or recommended
            setSelectedBackend(gpuStatus?.installedBackend || gpu?.recommended || 'openblas');
            // LLM settings
            setLlmEnabled(settings.llmEnabled !== undefined ? settings.llmEnabled : true);
            setLlmGpuMode(settings.llmGpuMode || 'auto');
            setLlmServerRunning(serverStatus?.isRunning || false);
            // LLM model statuses
            setLlmModels(modelStatus || {});
            // OUT-02: Review-first mode
            setReviewFirstMode(settings.reviewFirstMode || false);
            // Model preference
            setLlmModelPreference(settings.llmModelPreference || 'auto');
            // Hotkeys
            setHotkeyTranscribe(settings.hotkeyTranscribe || 'CommandOrControl+Alt+V');
            setHotkeyLlm(settings.hotkeyLlm || 'CommandOrControl+Alt+P');
            setHotkeyError(null);
        } catch {
            setError('Failed to load settings');
        } finally {
            setGpuDetecting(false);
        }
    };

    const refreshLlmModels = async () => {
        try {
            const modelStatus = await window.electronAPI.llmGetModelStatus?.();
            if (modelStatus) {
                setLlmModels(modelStatus);
            }
        } catch {
            // Silent — best effort refresh
        }
    };

    const handleDownloadModel = async (modelId) => {
        return window.electronAPI.llmDownloadModel?.(modelId);
    };

    const handleCancelDownload = async (modelId) => {
        return window.electronAPI.llmCancelDownload?.(modelId);
    };

    const handleDeleteModel = async (modelId) => {
        const result = await window.electronAPI.llmDeleteModel?.(modelId);
        await refreshLlmModels();
        return result;
    };

    const handleBackendSetup = async () => {
        setCppSetupRunning(true);
        setCppProgress(null);
        setError(null);
        try {
            const result = await window.electronAPI.whisperCppSetup({
                modelId: currentModel,
                backend: selectedBackend,
            });
            if (result.success) {
                const status = await window.electronAPI.whisperCppStatus();
                setCppStatus(status);
            } else {
                setError(result.error || 'Backend setup failed');
            }
        } catch (err) {
            setError(err.message);
        } finally {
            setCppSetupRunning(false);
            setCppProgress(null);
        }
    };

    const handleModelChange = async (modelId) => {
        if (modelId === currentModel) return;

        setIsLoading(true);
        setError(null);

        try {
            const result = await window.electronAPI.changeWhisperModel(modelId);
            if (result.success) {
                setCurrentModel(modelId);
            } else {
                setError(result.error || 'Failed to change model');
            }
        } catch (err) {
            setError(err.message);
        } finally {
            setIsLoading(false);
        }
    };

    const handleLanguageChange = async (languageCode) => {
        setCurrentLanguage(languageCode);
        try {
            await window.electronAPI.setSetting('whisperLanguage', languageCode);
        } catch {
            setError('Failed to save language setting');
        }
    };

    const handleToggleLlm = async (enabled) => {
        if (!enabled && llmServerRunning) {
            const confirmed = window.confirm('AI processing is active. Disable anyway?');
            if (!confirmed) return;
        }
        try {
            await window.electronAPI.setSetting('llmEnabled', enabled);
            setLlmEnabled(enabled);
        } catch {
            setError('Failed to save LLM setting');
        }
    };

    const handleChangeGpuMode = async (mode) => {
        try {
            await window.electronAPI.llmSetGpuMode(mode);
            setLlmGpuMode(mode);
        } catch {
            setError('Failed to save GPU mode setting');
        }
    };

    const handleToggleReviewFirst = async () => {
        const newValue = !reviewFirstMode;
        try {
            await window.electronAPI.setSetting('reviewFirstMode', newValue);
            setReviewFirstMode(newValue);
        } catch {
            setError('Failed to save review-first mode setting');
        }
    };

    /**
     * Convert a KeyboardEvent to an Electron accelerator string.
     * e.g., Ctrl+Alt+V, CommandOrControl+Shift+P
     */
    const keyEventToAccelerator = (e) => {
        const parts = [];
        if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');

        // Map key to Electron accelerator name
        const key = e.key;
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null; // modifier-only, not complete

        // Map special keys
        const keyMap = {
            ' ': 'Space', 'ArrowUp': 'Up', 'ArrowDown': 'Down',
            'ArrowLeft': 'Left', 'ArrowRight': 'Right',
            'Escape': 'Escape', 'Enter': 'Return', 'Backspace': 'Backspace',
            'Delete': 'Delete', 'Tab': 'Tab',
        };
        const mappedKey = keyMap[key] || (key.length === 1 ? key.toUpperCase() : key);
        parts.push(mappedKey);
        return parts.join('+');
    };

    /**
     * Format an Electron accelerator string for display.
     * e.g., "CommandOrControl+Alt+V" → "Ctrl+Alt+V"
     */
    const formatAccelerator = (accel) => {
        if (!accel) return '';
        return accel
            .replace('CommandOrControl', 'Ctrl')
            .replace('Command', 'Cmd');
    };

    const handleHotkeyKeyDown = (e, which) => {
        e.preventDefault();
        e.stopPropagation();
        const accel = keyEventToAccelerator(e);
        if (!accel) return; // modifier-only press, wait for full combo

        // Save immediately
        const setter = which === 'transcribe' ? setHotkeyTranscribe : setHotkeyLlm;
        const settingKey = which === 'transcribe' ? 'hotkeyTranscribe' : 'hotkeyLlm';
        setter(accel);
        setHotkeyRecording(null);
        setHotkeyError(null);

        window.electronAPI.setSetting(settingKey, accel).then(result => {
            if (!result.success) {
                setHotkeyError(result.error || 'Failed to save hotkey');
            }
        }).catch(() => {
            setHotkeyError('Failed to save hotkey');
        });
    };

    // Build backend options based on detected GPU
    const getBackendOptions = () => {
        const options = [];
        if (gpuInfo?.nvidia) {
            if (gpuInfo.nvidia.cudaMajor >= 12) {
                options.push({ id: 'cuda12', label: 'CUDA 12', recommended: gpuInfo.recommended === 'cuda12' });
            }
            if (gpuInfo.nvidia.cudaMajor >= 11) {
                options.push({ id: 'cuda11', label: 'CUDA 11', recommended: gpuInfo.recommended === 'cuda11' });
            }
        }
        options.push({ id: 'openblas', label: 'CPU Accelerated (OpenBLAS)', recommended: gpuInfo?.recommended === 'openblas' });
        options.push({ id: 'cpu', label: 'Basic CPU', recommended: false });
        return options;
    };

    // Determine the primary detected GPU info
    const getPrimaryGpu = () => {
        if (!gpuInfo?.gpus?.length) return null;
        // Prefer discrete GPUs (nvidia > amd > intel > unknown)
        const priority = ['nvidia', 'amd', 'intel', 'unknown'];
        for (const vendor of priority) {
            const gpu = gpuInfo.gpus.find(g => g.vendor === vendor);
            if (gpu) return gpu;
        }
        return gpuInfo.gpus[0];
    };

    const primaryGpu = gpuInfo ? getPrimaryGpu() : null;
    const isAmdOrIntel = primaryGpu && (primaryGpu.vendor === 'amd' || primaryGpu.vendor === 'intel');
    const backendOptions = getBackendOptions();
    const isReady = cppStatus?.available;
    const installedBackend = cppStatus?.installedBackend;
    const needsSwitch = installedBackend && selectedBackend !== installedBackend;

    if (!isOpen) return null;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h2>Settings</h2>
                    <button className="close-btn" onClick={onClose}>&times;</button>
                </div>

                <div className="modal-body">
                    {/* Hotkeys Configuration */}
                    <section className="settings-section hotkeys-section">
                        <h3 className="section-title">Hotkeys</h3>
                        <span className="hotkeys-description">
                            Either hotkey starts recording. The one you press to stop determines the mode.
                        </span>

                        <div className="hotkey-row">
                            <div className="hotkey-label-group">
                                <span className="hotkey-label">Transcribe</span>
                                <span className="hotkey-hint">Stop recording &rarr; paste raw text</span>
                            </div>
                            <button
                                className={`hotkey-button ${hotkeyRecording === 'transcribe' ? 'hotkey-button--recording' : ''}`}
                                onKeyDown={(e) => hotkeyRecording === 'transcribe' && handleHotkeyKeyDown(e, 'transcribe')}
                                onClick={() => setHotkeyRecording(hotkeyRecording === 'transcribe' ? null : 'transcribe')}
                                onBlur={() => setHotkeyRecording(null)}
                            >
                                {hotkeyRecording === 'transcribe' ? 'Press keys...' : formatAccelerator(hotkeyTranscribe)}
                            </button>
                        </div>

                        <div className="hotkey-row">
                            <div className="hotkey-label-group">
                                <span className="hotkey-label">LLM Process</span>
                                <span className="hotkey-hint">Stop recording &rarr; AI processes transcript</span>
                            </div>
                            <button
                                className={`hotkey-button ${hotkeyRecording === 'llm' ? 'hotkey-button--recording' : ''}`}
                                onKeyDown={(e) => hotkeyRecording === 'llm' && handleHotkeyKeyDown(e, 'llm')}
                                onClick={() => setHotkeyRecording(hotkeyRecording === 'llm' ? null : 'llm')}
                                onBlur={() => setHotkeyRecording(null)}
                            >
                                {hotkeyRecording === 'llm' ? 'Press keys...' : formatAccelerator(hotkeyLlm)}
                            </button>
                        </div>

                        {hotkeyError && (
                            <span className="hotkey-error">{hotkeyError}</span>
                        )}
                    </section>

                    {/* AI Processing Section — LLM enable/disable, model manager, and GPU/CPU mode */}
                    <div ref={llmSectionRef}>
                        <LlmSettingsSection
                            llmEnabled={llmEnabled}
                            llmGpuMode={llmGpuMode}
                            gpuInfo={gpuInfo}
                            llmServerRunning={llmServerRunning}
                            onToggleLlm={handleToggleLlm}
                            onChangeGpuMode={handleChangeGpuMode}
                            llmModels={llmModels}
                            onDownloadModel={handleDownloadModel}
                            onCancelDownload={handleCancelDownload}
                            onDeleteModel={handleDeleteModel}
                            highlight={highlightLlm}
                        />
                    </div>

                    {/* OUT-02: Review-first mode toggle — only shown when LLM is enabled */}
                    {llmEnabled && (
                        <section className="settings-section review-first-section">
                            <div className="review-first-row">
                                <div className="review-first-label-group">
                                    <span className="review-first-label">Review before pasting</span>
                                    <span className="review-first-description">
                                        Show LLM output in a popup for review before pasting to cursor
                                    </span>
                                </div>
                                <button
                                    className={`llm-switch ${reviewFirstMode ? 'llm-switch--on' : ''}`}
                                    role="switch"
                                    aria-checked={reviewFirstMode}
                                    onClick={handleToggleReviewFirst}
                                    type="button"
                                >
                                    <span className="llm-switch-thumb" />
                                </button>
                            </div>
                        </section>
                    )}

                    {/* Model Preference — only shown when LLM is enabled */}
                    {llmEnabled && (
                        <section className="settings-section model-preference-section">
                            <div className="model-preference-row">
                                <div className="model-preference-label-group">
                                    <span className="model-preference-label">AI Model</span>
                                    <span className="model-preference-description">
                                        Choose between speed and quality for text processing
                                    </span>
                                </div>
                                <select
                                    className="model-preference-select"
                                    value={llmModelPreference}
                                    onChange={async (e) => {
                                        const newPref = e.target.value;
                                        setLlmModelPreference(newPref);
                                        await window.electronAPI.setSetting('llmModelPreference', newPref);
                                    }}
                                >
                                    <option value="auto">Auto</option>
                                    <option value="9b">Quality (9B){llmModels['qwen3.5-9b']?.installed ? '' : ' — not downloaded'}</option>
                                    <option value="4b">Fast (4B){llmModels['qwen3.5-4b']?.installed ? '' : ' — not downloaded'}</option>
                                </select>
                            </div>
                        </section>
                    )}

                    {/* GPU Backend Section */}
                    <section className="settings-section gpu-section">
                        <h3>GPU Backend</h3>
                        <p className="section-description">
                            Select the whisper.cpp backend for transcription. GPU backends are faster; CPU works everywhere.
                        </p>

                        {/* GPU Detection Results */}
                        {gpuDetecting && (
                            <div className="gpu-status gpu-detecting">
                                <span className="gpu-status-dot" />
                                <span>Detecting GPU...</span>
                            </div>
                        )}

                        {!gpuDetecting && gpuInfo && (
                            <div className={`gpu-status ${primaryGpu?.vendor === 'nvidia' ? 'gpu-nvidia' : primaryGpu ? 'gpu-other' : 'gpu-none'}`}>
                                <span className="gpu-status-dot" />
                                <div className="gpu-status-text">
                                    <span className="gpu-name">{gpuInfo.summary}</span>
                                    {isAmdOrIntel && (
                                        <span className="gpu-vulkan-note">
                                            Vulkan GPU builds not yet available in official releases. Using CPU acceleration.
                                        </span>
                                    )}
                                </div>
                            </div>
                        )}

                        {!gpuDetecting && !gpuInfo && (
                            <div className="gpu-status gpu-none">
                                <span className="gpu-status-dot" />
                                <span>No dedicated GPU detected</span>
                            </div>
                        )}

                        {/* Backend Selector */}
                        {!gpuDetecting && (
                            <div className="backend-selector">
                                <span className="backend-label">Backend:</span>
                                <div className="backend-options">
                                    {backendOptions.map(opt => (
                                        <label key={opt.id} className={`backend-option ${selectedBackend === opt.id ? 'selected' : ''}`}>
                                            <input
                                                type="radio"
                                                name="backend"
                                                value={opt.id}
                                                checked={selectedBackend === opt.id}
                                                onChange={() => setSelectedBackend(opt.id)}
                                                disabled={cppSetupRunning}
                                            />
                                            <span>{opt.label}</span>
                                            {opt.recommended && <span className="recommended-badge">Recommended</span>}
                                            {installedBackend === opt.id && isReady && <span className="installed-badge">Installed</span>}
                                        </label>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Setup / Status */}
                        {isReady && !needsSwitch && (
                            <div className="gpu-status gpu-ready">
                                <span className="gpu-status-dot" />
                                <span>Backend ready ({BACKEND_LABELS[installedBackend] || installedBackend})</span>
                            </div>
                        )}

                        {(!isReady || needsSwitch) && !gpuDetecting && (
                            <button
                                className="btn-gpu-setup"
                                onClick={handleBackendSetup}
                                disabled={cppSetupRunning}
                            >
                                {cppSetupRunning
                                    ? cppProgress
                                        ? `${cppProgress.type === 'binary' ? 'Downloading binary' : 'Downloading model'}... ${cppProgress.percent || 0}%`
                                        : 'Setting up...'
                                    : needsSwitch
                                        ? `Switch to ${BACKEND_LABELS[selectedBackend] || selectedBackend}`
                                        : `Setup ${BACKEND_LABELS[selectedBackend] || selectedBackend} Backend`}
                            </button>
                        )}

                        {error && <div className="error-message">{error}</div>}
                    </section>

                    <section className="settings-section">
                        <h3>Whisper Model</h3>
                        <p className="section-description">
                            Select the speech recognition model. Larger models are more accurate but slower and require more disk space.
                        </p>

                        <div className="model-list">
                            {models.map(model => (
                                <label
                                    key={model.id}
                                    className={`model-option ${currentModel === model.id ? 'selected' : ''} ${isLoading ? 'disabled' : ''}`}
                                >
                                    <input
                                        type="radio"
                                        name="whisperModel"
                                        value={model.id}
                                        checked={currentModel === model.id}
                                        onChange={() => handleModelChange(model.id)}
                                        disabled={isLoading}
                                    />
                                    <div className="model-info">
                                        <span className="model-name">{model.name}</span>
                                        <span className="model-size">{model.size}</span>
                                        <span className="model-description">{model.description}</span>
                                    </div>
                                    {currentModel === model.id && (
                                        <span className="current-badge">Current</span>
                                    )}
                                </label>
                            ))}
                        </div>

                        {isLoading && (
                            <div className="loading-message">
                                Switching model... The new model will be downloaded on next transcription if not cached.
                            </div>
                        )}
                    </section>

                    {/* Language Section */}
                    <section className="settings-section language-section">
                        <h3>Transcription Language</h3>
                        <p className="section-description">
                            Select the language of your speech. Setting a specific language improves accuracy
                            and prevents Whisper from translating to English.
                        </p>

                        <div className="language-selector">
                            <select
                                className="language-select"
                                value={currentLanguage}
                                onChange={(e) => handleLanguageChange(e.target.value)}
                                disabled={currentModel.endsWith('.en')}
                            >
                                {LANGUAGE_OPTIONS.map(lang => (
                                    <option key={lang.code} value={lang.code}>
                                        {lang.label}{lang.code !== 'auto' ? ` (${lang.code})` : ''}
                                    </option>
                                ))}
                            </select>
                            {currentModel.endsWith('.en') && (
                                <p className="language-note">
                                    Language selection is disabled for English-only models.
                                </p>
                            )}
                        </div>
                    </section>
                </div>

                <div className="modal-footer">
                    <button className="btn-secondary" onClick={onClose}>
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}

export default SettingsModal;
