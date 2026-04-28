import { useState, useEffect, useCallback } from 'react';
import './LlmSettingsSection.css';

// ─── Format helpers ────────────────────────────────────────────────────────────

/**
 * Format bytes/sec to "12.3 MB/s" string.
 * @param {number} bytesPerSec
 * @returns {string}
 */
function formatSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec <= 0) return '0 B/s';
    if (bytesPerSec >= 1024 * 1024) {
        return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
    }
    if (bytesPerSec >= 1024) {
        return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
    }
    return `${Math.round(bytesPerSec)} B/s`;
}

/**
 * Format seconds remaining to "~3 min left" or "~45 sec left".
 * @param {number|null} seconds
 * @returns {string}
 */
function formatEta(seconds) {
    if (seconds === null || seconds === undefined || seconds < 0) return '';
    if (seconds >= 3600) {
        const h = Math.floor(seconds / 3600);
        return `~${h} hr left`;
    }
    if (seconds >= 60) {
        const m = Math.ceil(seconds / 60);
        return `~${m} min left`;
    }
    return `~${seconds} sec left`;
}

// ─── ModelRow sub-component ────────────────────────────────────────────────────

function ModelRow({
    model,
    isDownloading,
    isQueued,
    isPendingDelete,
    progress,
    errorMessage,
    onDownload,
    onCancel,
    onDelete,
    onUndoDelete,
    llmEnabled,
}) {
    const { id, label, technicalName, sizeLabel, intents, installed } = model;

    // Determine primary role tag (first intent)
    const roleLabel = intents?.[0]
        ? intents[0].charAt(0).toUpperCase() + intents[0].slice(1)
        : '';

    // ── Undo window (pending delete) ──────────────────────────────────────────
    if (isPendingDelete) {
        return (
            <div className="llm-model-row llm-undo-row">
                <div className="llm-undo-row__text">
                    <span className="llm-model-name">{label}</span>
                    <span className="llm-undo-label">Deleted</span>
                </div>
                <button
                    type="button"
                    className="llm-btn-undo"
                    onClick={() => onUndoDelete(id)}
                >
                    Undo
                </button>
            </div>
        );
    }

    // ── Downloading state ─────────────────────────────────────────────────────
    if (isDownloading) {
        const percent = progress?.percent ?? 0;
        const speed = progress?.speed ?? 0;
        const eta = progress?.eta ?? null;

        return (
            <div className="llm-model-row">
                <div className="llm-model-info">
                    <span className="llm-model-name">{label}</span>
                    <span className="llm-model-sub">{technicalName}</span>
                </div>
                <div className="llm-model-actions llm-model-actions--progress">
                    <div className="llm-progress-bar">
                        <div
                            className="llm-progress-fill"
                            style={{ width: `${percent}%` }}
                        />
                    </div>
                    <p className="llm-progress-text">
                        {percent}% &mdash; {formatSpeed(speed)}{eta ? ` \u2014 ${formatEta(eta)}` : ''}
                    </p>
                    <button
                        type="button"
                        className="llm-btn-cancel"
                        onClick={() => onCancel(id)}
                        title="Cancel download"
                    >
                        Cancel
                    </button>
                </div>
            </div>
        );
    }

    // ── Error state ───────────────────────────────────────────────────────────
    if (errorMessage) {
        return (
            <div className="llm-model-row">
                <div className="llm-model-info">
                    <span className="llm-model-name">{label}</span>
                    <span className="llm-model-sub">{technicalName} &bull; {sizeLabel}</span>
                </div>
                <div className="llm-model-actions">
                    <span className="llm-error-text" title={errorMessage}>
                        {errorMessage.length > 60 ? errorMessage.slice(0, 57) + '...' : errorMessage}
                    </span>
                    <button
                        type="button"
                        className="llm-btn-retry"
                        onClick={() => onDownload(id)}
                        disabled={!llmEnabled}
                    >
                        Retry
                    </button>
                </div>
            </div>
        );
    }

    // ── Installed state ───────────────────────────────────────────────────────
    if (installed) {
        return (
            <div className="llm-model-row">
                <div className="llm-model-info">
                    <span className="llm-model-name">{label}</span>
                    <span className="llm-model-sub">{technicalName}</span>
                    {roleLabel && <span className="llm-model-role">{roleLabel}</span>}
                </div>
                <div className="llm-model-actions">
                    <span className="llm-installed-badge">Installed &mdash; {sizeLabel} on disk</span>
                    <button
                        type="button"
                        className="llm-btn-delete"
                        onClick={() => onDelete(id)}
                        disabled={!llmEnabled}
                        title="Delete model"
                    >
                        Delete
                    </button>
                </div>
            </div>
        );
    }

    // ── Not downloaded state ──────────────────────────────────────────────────
    return (
        <div className="llm-model-row">
            <div className="llm-model-info">
                <span className="llm-model-name">{label}</span>
                <span className="llm-model-sub">{technicalName} &bull; {sizeLabel}</span>
                {roleLabel && <span className="llm-model-role">{roleLabel}</span>}
            </div>
            <div className="llm-model-actions">
                {isQueued ? (
                    <span className="llm-queued-badge">Queued</span>
                ) : (
                    <button
                        type="button"
                        className="llm-btn-download"
                        onClick={() => onDownload(id)}
                        disabled={!llmEnabled}
                    >
                        Download
                    </button>
                )}
            </div>
        </div>
    );
}

// ─── LlmSettingsSection ────────────────────────────────────────────────────────

function LlmSettingsSection({
    llmEnabled,
    llmGpuMode,
    gpuInfo,
    onToggleLlm,
    onChangeGpuMode,
    llmModels,
    onDownloadModel,
    onCancelDownload,
    onDeleteModel,
    highlight,
}) {
    const hasNvidiaGpu = !!(gpuInfo?.nvidia);

    // ── Model manager state ──────────────────────────────────────────────────
    const [downloadingModelId, setDownloadingModelId] = useState(null);
    const [queuedModelId, setQueuedModelId] = useState(null);
    const [progress, setProgress] = useState(null);
    const [errorModelId, setErrorModelId] = useState(null);
    const [errorMessage, setErrorMessage] = useState(null);
    // undoPending: { modelId, timerId }
    const [undoPending, setUndoPending] = useState(null);
    // Local copy of model statuses (updated after downloads / deletes)
    const [modelStatuses, setModelStatuses] = useState(llmModels || {});

    // Keep modelStatuses in sync when the parent refreshes llmModels
    useEffect(() => {
        if (llmModels) {
            setModelStatuses(llmModels);
        }
    }, [llmModels]);

    // ── Subscribe to download progress ────────────────────────────────────────
    useEffect(() => {
        if (!window.electronAPI?.onLlmDownloadProgress) return;
        const unsub = window.electronAPI.onLlmDownloadProgress((payload) => {
            setProgress(payload);
        });
        return () => unsub?.();
    }, []);

    // ── refreshModels ─────────────────────────────────────────────────────────
    const refreshModels = useCallback(async () => {
        try {
            const updated = await window.electronAPI.llmGetModelStatus?.();
            if (updated) {
                setModelStatuses(updated);
            }
        } catch {
            // Silent — refreshModels is best-effort
        }
    }, []);

    // ── handleDownload ────────────────────────────────────────────────────────
    const handleDownload = useCallback(async (modelId) => {
        // If a download is already active, queue this one
        if (downloadingModelId && downloadingModelId !== modelId) {
            setQueuedModelId(modelId);
            return;
        }

        // Clear any previous error for this model
        if (errorModelId === modelId) {
            setErrorModelId(null);
            setErrorMessage(null);
        }

        setDownloadingModelId(modelId);
        setProgress(null);

        try {
            const result = await onDownloadModel(modelId);
            if (result && !result.success) {
                setErrorModelId(modelId);
                setErrorMessage(result.error || 'Download failed');
            }
        } catch (err) {
            if (err?.message !== 'Download cancelled') {
                setErrorModelId(modelId);
                setErrorMessage(err?.message || 'Download failed');
            }
        } finally {
            const justFinishedId = modelId;
            setDownloadingModelId(null);
            setProgress(null);

            // Refresh model status from disk
            await refreshModels();

            // Start queued download if any (and not the one that just finished)
            setQueuedModelId((prevQueued) => {
                if (prevQueued && prevQueued !== justFinishedId) {
                    // Trigger the queued download asynchronously
                    setTimeout(() => handleDownload(prevQueued), 0);
                    return null;
                }
                return null;
            });
        }
    }, [downloadingModelId, errorModelId, onDownloadModel, refreshModels]);

    // ── handleCancel ──────────────────────────────────────────────────────────
    const handleCancel = useCallback(async (modelId) => {
        try {
            await onCancelDownload(modelId);
        } catch {
            // Cancel errors are non-fatal
        }
        setDownloadingModelId(null);
        setProgress(null);
        // Do NOT auto-start queued model on explicit cancel
        setQueuedModelId(null);
    }, [onCancelDownload]);

    // ── handleDelete (with 5-second undo) ────────────────────────────────────
    const handleDelete = useCallback((modelId) => {
        // If another undo is pending, immediately confirm that delete first
        if (undoPending) {
            clearTimeout(undoPending.timerId);
            onDeleteModel(undoPending.modelId).then(() => refreshModels()).catch(() => {});
        }

        const timerId = setTimeout(async () => {
            setUndoPending(null);
            try {
                await onDeleteModel(modelId);
                await refreshModels();
            } catch {
                // If delete fails, refresh to show current state
                await refreshModels();
            }
        }, 5000);

        setUndoPending({ modelId, timerId });
    }, [undoPending, onDeleteModel, refreshModels]);

    // ── handleUndoDelete ─────────────────────────────────────────────────────
    const handleUndoDelete = useCallback((modelId) => {
        if (undoPending && undoPending.modelId === modelId) {
            clearTimeout(undoPending.timerId);
            setUndoPending(null);
        }
    }, [undoPending]);

    // Cleanup undo timer on unmount
    useEffect(() => {
        return () => {
            if (undoPending) {
                clearTimeout(undoPending.timerId);
            }
        };
    }, [undoPending]);

    const modelEntries = Object.entries(modelStatuses);

    return (
        <section className="settings-section llm-section">
            <h3>AI Processing</h3>
            <p className="section-description">
                Enable AI-powered text processing with local LLM models. Your data never leaves your device.
            </p>

            {/* Enable / Disable toggle */}
            <div className="llm-toggle-row">
                <span className="llm-toggle-label">Enable AI Processing</span>
                <button
                    className={`llm-switch ${llmEnabled ? 'llm-switch--on' : ''}`}
                    role="switch"
                    aria-checked={llmEnabled}
                    onClick={() => onToggleLlm(!llmEnabled)}
                    type="button"
                >
                    <span className="llm-switch-thumb" />
                </button>
            </div>

            <div className="llm-divider" />

            {/* GPU / CPU mode selector */}
            <div className={`llm-gpu-area ${!llmEnabled ? 'llm-disabled' : ''}`}>
                <span className="llm-gpu-label">Inference Mode</span>
                <div className="llm-gpu-selector">
                    {(['auto', 'gpu', 'cpu']).map((mode) => {
                        const isGpuOption = mode === 'gpu';
                        const isDisabledOption = isGpuOption && !hasNvidiaGpu;
                        return (
                            <div key={mode} className="llm-gpu-option-wrapper">
                                <button
                                    type="button"
                                    className={`llm-gpu-option ${llmGpuMode === mode ? 'llm-gpu-option--selected' : ''} ${isDisabledOption ? 'llm-gpu-option--unavailable' : ''}`}
                                    onClick={() => !isDisabledOption && onChangeGpuMode(mode)}
                                    disabled={isDisabledOption || !llmEnabled}
                                    aria-pressed={llmGpuMode === mode}
                                    title={isDisabledOption ? 'No compatible GPU detected' : undefined}
                                >
                                    {mode === 'auto' ? 'Auto' : mode === 'gpu' ? 'GPU' : 'CPU'}
                                </button>
                                {isDisabledOption && (
                                    <span className="llm-tooltip">No compatible GPU detected</span>
                                )}
                            </div>
                        );
                    })}
                </div>
                <p className="llm-gpu-hint">
                    {llmGpuMode === 'auto'
                        ? 'Automatically uses GPU when available, falls back to CPU'
                        : llmGpuMode === 'gpu'
                            ? 'Forces all model layers onto the GPU (requires NVIDIA GPU)'
                            : 'Runs entirely on CPU — slower but works everywhere'}
                </p>
            </div>

            <div className="llm-divider" />

            {/* Model download manager */}
            <div className={`llm-models-area ${!llmEnabled ? 'llm-disabled' : ''} ${highlight ? 'llm-highlight-glow' : ''}`}>
                <span className="llm-models-label">Local Models</span>
                {modelEntries.length === 0 ? (
                    <p className="llm-models-empty">Loading models...</p>
                ) : (
                    modelEntries.map(([modelId, model]) => (
                        <ModelRow
                            key={modelId}
                            model={model}
                            isDownloading={downloadingModelId === modelId}
                            isQueued={queuedModelId === modelId}
                            isPendingDelete={undoPending?.modelId === modelId}
                            progress={downloadingModelId === modelId ? progress : null}
                            errorMessage={errorModelId === modelId ? errorMessage : null}
                            onDownload={handleDownload}
                            onCancel={handleCancel}
                            onDelete={handleDelete}
                            onUndoDelete={handleUndoDelete}
                            llmEnabled={llmEnabled}
                        />
                    ))
                )}
            </div>
        </section>
    );
}

export default LlmSettingsSection;
