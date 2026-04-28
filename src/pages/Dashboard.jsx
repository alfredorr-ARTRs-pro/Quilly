import { useState, useEffect, useRef, useCallback } from 'react';
import AudioEditor from '../components/AudioEditor';
import SettingsModal from '../components/SettingsModal';
import FirstRunModal from '../components/FirstRunModal';
import { ToastContainer, toast } from '../components/Toast';
import { processAudioForTranscription } from '../utils/audioProcessing';
import storageService from '../services/storage';
import './Dashboard.css';

function Dashboard() {
    const [recordings, setRecordings] = useState([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [expandedIds, setExpandedIds] = useState(new Set());
    const [copiedId, setCopiedId] = useState(null);
    const [currentAudioBlob, setCurrentAudioBlob] = useState(null);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [deepLinkLlm, setDeepLinkLlm] = useState(false);
    const [showGhosts, setShowGhosts] = useState(true);
    const [isTranscribing, setIsTranscribing] = useState(false);
    const [isProcessingLlm, setIsProcessingLlm] = useState(false);
    const [processingState, setProcessingState] = useState({
        phase: 'idle', // 'idle' | 'transcribing' | 'processing' | 'done' | 'error'
        activeSegmentIndex: null,
        stepProgress: null, // { current, total }
        error: null
    });
    const [processResult, setProcessResult] = useState(null); // { text, intentLabel, originalText, instructionUsed }
    const [resultCopied, setResultCopied] = useState(false);
    const [showOriginal, setShowOriginal] = useState(false);
    const audioEditorRef = useRef(null);
    const abortControllerRef = useRef(null);
    const resultCopiedTimerRef = useRef(null);
    const resultBodyRef = useRef(null);
    const instructionRef = useRef(null);
    // Load recordings from storage on mount
    useEffect(() => {
        setRecordings(storageService.getAll());
    }, []);

    // Listen for recordings from overlay
    useEffect(() => {
        if (window.electronAPI && window.electronAPI.onAddRecording) {
            const unsubscribe = window.electronAPI.onAddRecording((recording) => {
                console.log('Received recording from overlay:', recording);
                const newRecording = storageService.add(recording);
                console.log('Saved to storage:', newRecording);
                setRecordings(storageService.getAll());
            });
            return unsubscribe;
        }
    }, []);

    // UI-05: Listen for deep-link to open SettingsModal at LLM section
    useEffect(() => {
        if (!window.electronAPI?.onLlmOpenSettingsLlm) return;
        const unsub = window.electronAPI.onLlmOpenSettingsLlm(() => {
            setIsSettingsOpen(true);
            setDeepLinkLlm(true);
        });
        return () => unsub?.();
    }, []);

    const filteredRecordings = recordings.filter(r => {
        if (!showGhosts && r.isGhost) return false;
        return r.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            (r.transcription && r.transcription.toLowerCase().includes(searchQuery.toLowerCase()));
    });

    const toggleSelect = (id) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    };

    const toggleSelectAll = () => {
        if (selectedIds.size === filteredRecordings.length) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(filteredRecordings.map(r => r.id)));
        }
    };

    const toggleExpanded = (id) => {
        setExpandedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const copyText = async (text, identifier) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopiedId(identifier);
            setTimeout(() => setCopiedId(null), 1500);
        } catch {
            toast.error('Failed to copy.');
        }
    };

    const deleteSelected = () => {
        storageService.deleteMultiple(Array.from(selectedIds));
        setRecordings(storageService.getAll());
        setSelectedIds(new Set());
    };

    const deleteRecording = (id) => {
        storageService.delete(id);
        setRecordings(storageService.getAll());
    };

    const updateRecordingName = (id, name) => {
        storageService.update(id, { name });
        setRecordings(storageService.getAll());
    };

    const transcribeSelected = () => {
        toast.info('Batch transcription is not yet implemented.');
    };

    // Helper: save the current (possibly edited) result to history, then clear panel
    const dismissProcessResult = useCallback(() => {
        if (!processResult) return;
        const editedText = resultBodyRef.current?.innerText || processResult.text;
        storageService.add({
            name: processResult.intentLabel || 'Processed result',
            transcription: editedText,
            originalText: processResult.originalText || null,
            instructionUsed: processResult.instructionUsed || null,
            status: 'transcribed',
            date: new Date().toISOString()
        });
        setRecordings(storageService.getAll());
        setProcessResult(null);
        setShowOriginal(false);
    }, [processResult]);

    const handleRecordingComplete = (blob) => {
        // Auto-dismiss result panel on new recording (save to history first)
        if (processResult) {
            dismissProcessResult();
        }
        setCurrentAudioBlob(blob);
    };

    const handleTranscribe = useCallback(async () => {
        // Auto-dismiss result panel on new transcription
        // Note: dismissProcessResult depends on processResult via ref, safe to call inline
        if (processResult) {
            dismissProcessResult();
        }
        setIsTranscribing(true);

        const loadingToastId = toast.loading('Processing audio...');

        try {
            const blob = await audioEditorRef.current?.getAudioBlob();

            if (!blob) {
                throw new Error('No audio to transcribe. Please record or import audio first.');
            }

            toast.update(loadingToastId, 'Transcribing...', 'loading');

            // Save audio to temp file for history playback
            let audioPath = null;
            try {
                const arrayBuffer = await blob.arrayBuffer();
                const saveResult = await window.electronAPI.saveAudioTemp(arrayBuffer);
                if (saveResult.success) {
                    audioPath = saveResult.path;
                    console.log('Audio saved to temp:', audioPath);
                } else {
                    console.error('Failed to save temp audio:', saveResult.error);
                }
            } catch (saveErr) {
                console.error('Error saving temp audio:', saveErr);
            }

            const { audioArray, durationStr } = await processAudioForTranscription(blob);
            const result = await window.electronAPI.transcribe(audioArray);

            if (result.success) {
                storageService.add({
                    name: `Transcription ${new Date().toLocaleTimeString()}`,
                    duration: durationStr,
                    status: 'transcribed',
                    transcription: result.text,
                    audioPath: audioPath
                });

                setRecordings(storageService.getAll());
                toast.remove(loadingToastId);
                toast.success('Transcription complete!');
            } else {
                throw new Error(result.error);
            }

        } catch (err) {
            console.error('Transcription failed:', err);
            toast.remove(loadingToastId);
            toast.error('Transcription failed: ' + err.message);
        } finally {
            setIsTranscribing(false);
        }
    }, [dismissProcessResult, processResult]);

    // PROC-01 through PROC-05: Process instruction-tagged segments through the LLM pipeline.
    // Each segment is transcribed individually. Instruction segments get "Quilly " prepended
    // (PROC-02 auto-wake-word injection). Non-instruction segments are concatenated as content
    // text (PROC-03). The assembled text is routed through transcriptionComplete which runs
    // intentRouter + LLM inference — the same path as hotkey recording.
    const handleProcess = useCallback(async () => {
        setIsProcessingLlm(true);

        // Create AbortController for cancel support
        const controller = new AbortController();
        abortControllerRef.current = controller;

        setProcessingState({
            phase: 'transcribing',
            activeSegmentIndex: 0,
            stepProgress: null,
            error: null
        });

        const loadingToastId = toast.loading('Transcribing segments...');

        try {
            const segmentBlobs = await audioEditorRef.current?.getSegmentsForProcessing();

            if (!segmentBlobs || segmentBlobs.length === 0) {
                throw new Error('No audio segments to process. Please record or import audio first.');
            }

            // Transcribe each segment individually
            const transcribedSegments = [];
            for (let i = 0; i < segmentBlobs.length; i++) {
                // Check for cancellation between transcription steps
                if (controller.signal.aborted) {
                    throw new Error('Processing cancelled');
                }

                setProcessingState(prev => ({
                    ...prev,
                    phase: 'transcribing',
                    activeSegmentIndex: i
                }));

                const { blob, isInstruction } = segmentBlobs[i];
                toast.update(loadingToastId, `Transcribing segment ${i + 1}/${segmentBlobs.length}...`, 'loading');
                const { audioArray } = await processAudioForTranscription(blob);
                const result = await window.electronAPI.transcribe(audioArray);
                if (result.success && result.text) {
                    transcribedSegments.push({ text: result.text.trim(), isInstruction });
                } else {
                    console.warn(`[handleProcess] Segment ${i + 1} transcription failed:`, result.error);
                    transcribedSegments.push({ text: '', isInstruction });
                }
            }

            // Check for cancellation before LLM call
            if (controller.signal.aborted) {
                throw new Error('Processing cancelled');
            }

            // PROC-02: inject wake word prefix for instruction segments
            // PROC-03: concatenate non-instruction segments as content text
            // PROC-04: chain multiple instructions with "and then" so routeChain detects them
            const settings = await window.electronAPI.getSettings();
            const wakeWord = settings?.wakeWord || 'Quilly';

            const instructionTexts = transcribedSegments
                .filter(s => s.isInstruction && s.text)
                .map(s => s.text);
            const contentParts = transcribedSegments
                .filter(s => !s.isInstruction && s.text)
                .map(s => s.text);

            // Single wake word prefix + instructions joined by "and then" conjunction.
            // routeChain detects chains via CHAIN_CONJUNCTIONS, not repeated wake words.
            const instructionStr = instructionTexts.length === 0
                ? ''
                : wakeWord + ' ' + instructionTexts.join(' and then ');

            // Assemble: content text first, then instruction chain
            // This matches the intentRouter's mid-sentence wake word handling where
            // content before the wake word is preserved as the user's content.
            const assembledText = [...contentParts, instructionStr].filter(Boolean).join(' ');

            if (!assembledText.trim()) {
                throw new Error('No transcription produced from segments. Check that the audio is clear.');
            }

            // Update to processing phase with step progress
            setProcessingState(prev => ({
                ...prev,
                phase: 'processing',
                activeSegmentIndex: null,
                stepProgress: { current: 1, total: instructionTexts.length || 1 }
            }));

            toast.update(loadingToastId, 'Processing with LLM...', 'loading');

            // Capture original text and instruction for result panel display
            const originalText = contentParts.join(' ');
            const instructionUsed = instructionTexts.join(' and then ');

            // PROC-05: route through existing LLM pipeline via transcriptionComplete
            // editorMode: skip paste/popup side effects — result shown in editor history
            const ipcResult = await window.electronAPI.transcriptionComplete(
                assembledText, 0, 0, null, null, {
                    editorMode: true,
                    editorContent: originalText || '',
                    editorInstruction: instructionUsed || '',
                }
            );

            toast.remove(loadingToastId);
            if (ipcResult?.llmProcessed && ipcResult?.processedResult) {
                // Show result in inline panel between editor and history
                setProcessResult({
                    text: ipcResult.processedResult,
                    intentLabel: ipcResult.intentLabel || 'Processed',
                    originalText: originalText || null,
                    instructionUsed: instructionUsed || null,
                });
                setResultCopied(false);
                setShowOriginal(false);
                toast.success(ipcResult.intentLabel || 'Processing complete!');
            } else if (ipcResult?.pastedText) {
                toast.success('Transcription complete (no LLM intent detected).');
            } else {
                toast.success('Processing complete!');
            }

            // Set done phase, clear after 2 seconds
            setProcessingState({
                phase: 'done',
                activeSegmentIndex: null,
                stepProgress: null,
                error: null
            });
            setTimeout(() => {
                setProcessingState({
                    phase: 'idle',
                    activeSegmentIndex: null,
                    stepProgress: null,
                    error: null
                });
            }, 2000);

        } catch (err) {
            if (err.message === 'Processing cancelled') {
                console.log('Processing cancelled by user');
                toast.remove(loadingToastId);
                toast.info('Processing cancelled');
                setProcessingState({
                    phase: 'idle',
                    activeSegmentIndex: null,
                    stepProgress: null,
                    error: null
                });
            } else {
                console.error('LLM processing failed:', err);
                toast.remove(loadingToastId);
                toast.error('Processing failed: ' + err.message);
                setProcessingState({
                    phase: 'error',
                    activeSegmentIndex: null,
                    stepProgress: null,
                    error: err.message
                });
            }
        } finally {
            setIsProcessingLlm(false);
            abortControllerRef.current = null;
        }
    }, []);

    const handleCancelProcess = useCallback(() => {
        abortControllerRef.current?.abort();
    }, []);

    const handleReprocess = useCallback(async (editedInstruction) => {
        const originalText = processResult?.originalText || '';

        // Save current result to history before re-processing
        dismissProcessResult();

        setIsProcessingLlm(true);
        setProcessingState({
            phase: 'processing',
            activeSegmentIndex: null,
            stepProgress: { current: 1, total: 1 },
            error: null
        });

        const loadingToastId = toast.loading('Re-processing with updated instruction...');

        try {
            const settings = await window.electronAPI.getSettings();
            const wakeWord = settings?.wakeWord || 'quilly';
            const assembledText = [originalText, wakeWord + ' ' + editedInstruction].filter(Boolean).join(' ');

            const ipcResult = await window.electronAPI.transcriptionComplete(
                assembledText, 0, 0, null, null, {
                    editorMode: true,
                    editorContent: originalText || '',
                    editorInstruction: editedInstruction || '',
                }
            );

            toast.remove(loadingToastId);
            if (ipcResult?.llmProcessed && ipcResult?.processedResult) {
                setProcessResult({
                    text: ipcResult.processedResult,
                    intentLabel: ipcResult.intentLabel || 'Processed',
                    originalText: originalText || null,
                    instructionUsed: editedInstruction || null,
                });
                setResultCopied(false);
                setShowOriginal(false);
                toast.success(ipcResult.intentLabel || 'Re-processing complete!');
            } else {
                toast.success('Re-processing complete (no LLM intent detected).');
            }

            setProcessingState({ phase: 'done', activeSegmentIndex: null, stepProgress: null, error: null });
            setTimeout(() => {
                setProcessingState({ phase: 'idle', activeSegmentIndex: null, stepProgress: null, error: null });
            }, 2000);
        } catch (err) {
            console.error('Re-processing failed:', err);
            toast.remove(loadingToastId);
            toast.error('Re-processing failed: ' + err.message);
            setProcessingState({ phase: 'error', activeSegmentIndex: null, stepProgress: null, error: err.message });
        } finally {
            setIsProcessingLlm(false);
        }
    }, [processResult, dismissProcessResult]);

    const handleRetryProcess = useCallback(() => {
        setProcessingState({
            phase: 'idle',
            activeSegmentIndex: null,
            stepProgress: null,
            error: null
        });
        handleProcess();
    }, [handleProcess]);

    const copyTranscription = async (transcription) => {
        if (!transcription) return;

        try {
            await navigator.clipboard.writeText(transcription);
            toast.success('Copied to clipboard!');
        } catch (err) {
            console.error('Failed to copy:', err);
            // Fallback for older browsers or restricted contexts
            const textArea = document.createElement('textarea');
            textArea.value = transcription;
            textArea.style.position = 'fixed';
            textArea.style.left = '-9999px';
            document.body.appendChild(textArea);
            textArea.select();
            try {
                document.execCommand('copy');
                toast.success('Copied to clipboard!');
            } catch {
                toast.error('Failed to copy. Please select and copy manually.');
            }
            document.body.removeChild(textArea);
        }
    };

    return (
        <div className="dashboard">
            {/* Header */}
            <header className="dashboard-header">
                <div className="header-content">
                    <div className="header-title">
                        <div className="title-row">
                            <img src="logo.png" alt="Quilly" className="header-logo" />
                        </div>
                        <p className="hotkey-hint">Press <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>V</kbd> for quick recording overlay</p>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        {/* <button
                            className="settings-btn"
                            onClick={() => navigate('/about')}
                            title="About Quilly"
                        >
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="10"></circle>
                                <line x1="12" y1="16" x2="12" y2="12"></line>
                                <line x1="12" y1="8" x2="12.01" y2="8"></line>
                            </svg>
                        </button> */}
                        <button
                            className="settings-btn"
                            onClick={() => setIsSettingsOpen(true)}
                            title="Settings"
                        >
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="12" cy="12" r="3" />
                                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                            </svg>
                        </button>
                    </div>
                </div>
            </header>

            {/* Main Content */}
            <main className="dashboard-main">
                {/* Recorder Section */}
                <section className="recorder-section">
                    <h2>Manual Recorder & Editor</h2>
                    <AudioEditor
                        ref={audioEditorRef}
                        audioBlob={currentAudioBlob}
                        onTranscribe={handleTranscribe}
                        onProcess={handleProcess}
                        onRecordingComplete={handleRecordingComplete}
                        isTranscribing={isTranscribing}
                        isProcessingLlm={isProcessingLlm}
                        processingState={processingState}
                        onCancelProcess={handleCancelProcess}
                        onRetryProcess={handleRetryProcess}
                    />
                </section>

                {/* Processing Result Panel — loading/error/result states */}
                {(processingState.phase === 'transcribing' || processingState.phase === 'processing') && !processResult && (
                    <section className="process-result-panel">
                        <div className="process-result-loading">
                            <div className="process-result-loading-pulse" />
                            <span>{processingState.phase === 'transcribing' ? 'Transcribing segments...' : 'Processing with LLM...'}</span>
                        </div>
                    </section>
                )}
                {processingState.phase === 'error' && !processResult && (
                    <section className="process-result-panel">
                        <div className="process-result-error">
                            <div>Processing failed: {processingState.error}</div>
                            <button className="process-result-error-retry" onClick={handleRetryProcess}>
                                Retry
                            </button>
                        </div>
                    </section>
                )}
                {processResult && (
                    <section className="process-result-panel">
                        <div className="process-result-header">
                            <div>
                                <span className="process-result-label">{processResult.intentLabel}</span>
                                {processResult.instructionUsed && (
                                    <div
                                        className="process-result-instruction"
                                        ref={instructionRef}
                                        contentEditable="true"
                                        suppressContentEditableWarning={true}
                                    >
                                        {processResult.instructionUsed}
                                    </div>
                                )}
                            </div>
                            <div className="process-result-actions">
                                <button
                                    className="process-result-reprocess"
                                    onClick={() => {
                                        const editedInstruction = instructionRef.current?.innerText || processResult.instructionUsed || '';
                                        handleReprocess(editedInstruction);
                                    }}
                                >
                                    Re-process
                                </button>
                                <button
                                    className={`process-result-copy${resultCopied ? ' copied' : ''}`}
                                    onClick={async () => {
                                        const textToCopy = resultBodyRef.current?.innerText || processResult.text;
                                        try {
                                            await navigator.clipboard.writeText(textToCopy);
                                        } catch {
                                            const ta = document.createElement('textarea');
                                            ta.value = textToCopy;
                                            document.body.appendChild(ta);
                                            ta.select();
                                            document.execCommand('copy');
                                            document.body.removeChild(ta);
                                        }
                                        setResultCopied(true);
                                        if (resultCopiedTimerRef.current) clearTimeout(resultCopiedTimerRef.current);
                                        resultCopiedTimerRef.current = setTimeout(() => setResultCopied(false), 1500);
                                    }}
                                >
                                    {resultCopied ? '\u2713 Copied' : '\u2398 Copy'}
                                </button>
                                <button
                                    className="process-result-close"
                                    onClick={dismissProcessResult}
                                    title="Dismiss"
                                >
                                    &times;
                                </button>
                            </div>
                        </div>
                        <div
                            className="process-result-body"
                            ref={resultBodyRef}
                            contentEditable="true"
                            suppressContentEditableWarning={true}
                        >
                            {processResult.text}
                        </div>
                        {processResult.originalText && (
                            <>
                                <button
                                    className="process-result-original-toggle"
                                    onClick={() => setShowOriginal(prev => !prev)}
                                >
                                    {showOriginal ? 'Hide original' : 'Show original'}
                                </button>
                                {showOriginal && (
                                    <div className="process-result-original">
                                        {processResult.originalText}
                                    </div>
                                )}
                            </>
                        )}
                    </section>
                )}

                {/* History Section */}
                <section className="history-section">
                    <div className="history-header">
                        <h2>Recording History</h2>
                        <div className="history-actions">
                            <input
                                type="search"
                                placeholder="Search recordings..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="search-input"
                            />
                            <button
                                className={`ghost-filter-toggle ${showGhosts ? 'active' : ''}`}
                                onClick={() => setShowGhosts(prev => !prev)}
                                title={showGhosts ? 'Hide dismissed/timed-out entries' : 'Show dismissed/timed-out entries'}
                            >
                                {showGhosts ? 'Showing all' : 'Hiding dismissed'}
                            </button>
                        </div>
                    </div>

                    {/* Bulk Actions Bar */}
                    {selectedIds.size > 0 && (
                        <div className="bulk-actions-bar">
                            <span className="selection-count">{selectedIds.size} selected</span>
                            <button className="bulk-btn" onClick={transcribeSelected} disabled={isTranscribing}>
                                {isTranscribing ? '⏳ Transcribing...' : '📝 Transcribe'}
                            </button>
                            <button className="bulk-btn" onClick={() => toast.info('Bulk export is not yet implemented.')}>💾 Export Selected</button>
                            <button className="bulk-btn danger" onClick={deleteSelected}>🗑️ Delete</button>
                            <button className="bulk-btn" onClick={() => setSelectedIds(new Set())}>✖ Clear Selection</button>
                        </div>
                    )}

                    <table className="history-table">
                        <thead>
                            <tr>
                                <th className="checkbox-col">
                                    <input
                                        type="checkbox"
                                        checked={selectedIds.size === filteredRecordings.length && filteredRecordings.length > 0}
                                        onChange={toggleSelectAll}
                                    />
                                </th>
                                <th>Name</th>
                                <th>Date</th>
                                <th>Duration</th>
                                <th>Status</th>
                                <th>Transcription</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredRecordings.length === 0 ? (
                                <tr>
                                    <td colSpan="7" className="empty-state">
                                        No recordings found. Start recording to create your first entry!
                                    </td>
                                </tr>
                            ) : (
                                filteredRecordings.map(recording => (
                                    <tr key={recording.id} className={`${selectedIds.has(recording.id) ? 'selected' : ''} ${recording.isGhost ? 'ghost-entry' : ''}`}>
                                        <td className="checkbox-col">
                                            <input
                                                type="checkbox"
                                                checked={selectedIds.has(recording.id)}
                                                onChange={() => toggleSelect(recording.id)}
                                            />
                                        </td>
                                        <td>
                                            <input
                                                type="text"
                                                value={recording.name}
                                                onChange={(e) => updateRecordingName(recording.id, e.target.value)}
                                                className="name-input"
                                            />
                                        </td>
                                        <td>{recording.date}</td>
                                        <td>{recording.duration}</td>
                                        <td>
                                            <span className={`status-badge ${recording.status}`}>
                                                {recording.status}
                                            </span>
                                        </td>
                                        <td className="transcription-cell">
                                            {recording.isGhost && (
                                                <div className={`ghost-label ghost-label--${recording.ghostReason}`}>
                                                    {recording.ghostReason === 'timed_out' ? 'Timed out' : 'Dismissed'}
                                                </div>
                                            )}
                                            {recording.rawTranscription ? (
                                                <div className="transcription-content">
                                                    <div className="processedResult">
                                                        <div className="transcription-preview" title={recording.transcription}>
                                                            {recording.transcription && recording.transcription.length > 60
                                                                ? recording.transcription.substring(0, 60) + '...'
                                                                : recording.transcription}
                                                        </div>
                                                        <button
                                                            className={`copy-btn-inline${copiedId === recording.id + '-processed' ? ' copied' : ''}`}
                                                            onClick={() => copyText(recording.transcription, recording.id + '-processed')}
                                                            title="Copy processed result"
                                                        >
                                                            {copiedId === recording.id + '-processed'
                                                                ? <span className="copied-label">Copied!</span>
                                                                : '📋'}
                                                        </button>
                                                    </div>
                                                    {recording.intentLabels && recording.intentLabels.length > 0 && (
                                                        <div className="intent-badges">
                                                            {recording.intentLabels.map((label, idx) => (
                                                                <span key={idx} className="intent-badge">
                                                                    <svg className="intent-badge-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                                        <path d="M12 20h9"/>
                                                                        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                                                                    </svg>
                                                                    {label}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    )}
                                                    <button
                                                        className="raw-transcription-toggle"
                                                        onClick={() => toggleExpanded(recording.id)}
                                                    >
                                                        {expandedIds.has(recording.id) ? 'Hide raw transcription' : 'Show raw transcription'}
                                                    </button>
                                                    {expandedIds.has(recording.id) && (
                                                        <div className="raw-transcription-section">
                                                            <span className="raw-transcription-text">{recording.rawTranscription}</span>
                                                            <button
                                                                className={`copy-btn-inline${copiedId === recording.id + '-raw' ? ' copied' : ''}`}
                                                                onClick={() => copyText(recording.rawTranscription, recording.id + '-raw')}
                                                                title="Copy raw transcription"
                                                            >
                                                                {copiedId === recording.id + '-raw'
                                                                    ? <span className="copied-label">Copied!</span>
                                                                    : '📋'}
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>
                                            ) : recording.transcription ? (
                                                <>
                                                    <div className="transcription-preview" title={recording.transcription}>
                                                        {recording.transcription.length > 60
                                                            ? recording.transcription.substring(0, 60) + '...'
                                                            : recording.transcription}
                                                    </div>
                                                    {recording.intentLabels && recording.intentLabels.length > 0 && (
                                                        <div className="intent-badges">
                                                            {recording.intentLabels.map((label, idx) => (
                                                                <span key={idx} className="intent-badge">
                                                                    <svg className="intent-badge-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                                        <path d="M12 20h9"/>
                                                                        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                                                                    </svg>
                                                                    {label}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    )}
                                                </>
                                            ) : (
                                                <span className="no-transcription">—</span>
                                            )}
                                        </td>
                                        <td className="actions-cell">
                                            {recording.isGhost && (
                                                <button
                                                    title="Recover — copy to clipboard and restore as normal entry"
                                                    className="recover-ghost-btn"
                                                    onClick={async () => {
                                                        const textToCopy = recording.transcription || recording.processedResult || recording.rawTranscription;
                                                        try {
                                                            await navigator.clipboard.writeText(textToCopy);
                                                        } catch {
                                                            if (window.electronAPI?.reviewPopupCopyToClipboard) {
                                                                await window.electronAPI.reviewPopupCopyToClipboard(textToCopy);
                                                            }
                                                        }
                                                        const updated = storageService.update(recording.id, { isGhost: false, ghostReason: null });
                                                        if (updated) {
                                                            setRecordings(storageService.getAll());
                                                            toast.success('Entry recovered and copied to clipboard');
                                                        }
                                                    }}
                                                >
                                                    Copy & Recover
                                                </button>
                                            )}
                                            <button
                                                title="Play"
                                                onClick={async () => {
                                                    if (!recording.audioPath) {
                                                        toast.error('Audio file path missing');
                                                        return;
                                                    }
                                                    try {
                                                        const result = await window.electronAPI.readAudioFile(recording.audioPath);
                                                        if (result.success && result.buffer) {
                                                            const blob = new Blob([result.buffer], { type: 'audio/webm' });
                                                            const url = URL.createObjectURL(blob);
                                                            const audio = new Audio(url);
                                                            audio.play();
                                                            toast.success('Playing audio...');
                                                        } else {
                                                            toast.error('Failed to load audio file: ' + (result.error || 'Unknown error'));
                                                        }
                                                    } catch (err) {
                                                        toast.error('Error playing audio: ' + err.message);
                                                    }
                                                }}
                                            >▶️</button>
                                            {/* Transcribe button removed as per request */}
                                            <button
                                                title="Copy Text"
                                                onClick={() => copyTranscription(recording.transcription)}
                                                disabled={!recording.transcription}
                                            >📋</button>
                                            <button
                                                title="Save As"
                                                onClick={async () => {
                                                    if (!recording.audioPath) {
                                                        toast.error('Audio file path missing');
                                                        return;
                                                    }
                                                    const result = await window.electronAPI.saveAudioFile(recording.audioPath);
                                                    if (result.success) {
                                                        toast.success('Saved to: ' + result.filePath);
                                                    } else if (!result.canceled) {
                                                        toast.error('Failed to save: ' + result.error);
                                                    }
                                                }}
                                            >💾</button>
                                            <button
                                                title="Delete"
                                                onClick={() => deleteRecording(recording.id)}
                                            >
                                                🗑️
                                            </button>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </section>
            </main>

            {/* Modals */}
            <SettingsModal
                isOpen={isSettingsOpen}
                onClose={() => setIsSettingsOpen(false)}
                deepLinkLlm={deepLinkLlm}
                onDeepLinkConsumed={() => setDeepLinkLlm(false)}
            />
            <FirstRunModal />

            {/* Toast notifications */}
            <ToastContainer />
        </div>
    );
}

export default Dashboard;
