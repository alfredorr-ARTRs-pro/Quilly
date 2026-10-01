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
    const [editorTranscript, setEditorTranscript] = useState(null);
    const [editorDiarization, setEditorDiarization] = useState(null);
    // Speaker diarization UI state — transient only (never persisted), so a
    // crash mid-job can't strand a stuck "detecting" status.
    const [diarizingIds, setDiarizingIds] = useState(new Set());
    const [speakerDialogRecording, setSpeakerDialogRecording] = useState(null);
    const [diarizeSetupState, setDiarizeSetupState] = useState(null); // null | {recording, progress?}
    const [speakerExpandedIds, setSpeakerExpandedIds] = useState(new Set());
    const [diarizeRename, setDiarizeRename] = useState(null); // {recordingId, speakerId, value} | null
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [deepLinkLlm, setDeepLinkLlm] = useState(false);
    const [developerConfig, setDeveloperConfig] = useState(null);
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
    // done→idle transition timer: must be cancelled when a new Process starts
    // within the 2s window, or it resets the UI mid-run.
    const doneTimerRef = useRef(null);
    const copiedTimerRef = useRef(null);
    // Shared playback element so history Play clicks don't overlap, plus the
    // object URL currently backing it (revoked on replace/end to avoid leaks).
    const playbackAudioRef = useRef(null);
    const playbackUrlRef = useRef(null);

    const loadDeveloperConfig = useCallback(async () => {
        if (!window.electronAPI?.developerConfigGet) return;
        try {
            const config = await window.electronAPI.developerConfigGet();
            setDeveloperConfig(config);
        } catch (err) {
            console.warn('Failed to load developer configuration:', err);
        }
    }, []);

    // Load recordings from storage on mount
    useEffect(() => {
        setRecordings(storageService.getAll());
        loadDeveloperConfig();
    }, [loadDeveloperConfig]);

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

    // Deferred updates to an existing entry (save-first flow: an entry is created
    // as 'transcribing' up front, then patched to 'transcribed'/'failed' here).
    useEffect(() => {
        if (window.electronAPI && window.electronAPI.onUpdateRecording) {
            const unsubscribe = window.electronAPI.onUpdateRecording(({ id, updates }) => {
                storageService.update(id, updates);
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
            if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
            copiedTimerRef.current = setTimeout(() => setCopiedId(null), 1500);
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

    // Turn a recording's saved audio file into a Blob (mirrors the Play button).
    const readRecordingBlob = useCallback(async (recording) => {
        const result = await window.electronAPI.readAudioFile(recording.audioPath);
        if (!result.success || !result.buffer) {
            throw new Error(result.error || 'Failed to read audio file');
        }
        const ext = recording.audioPath.split('.').pop()?.toLowerCase();
        const type = ext === 'wav' ? 'audio/wav' : ext === 'mp3' ? 'audio/mpeg' : 'audio/webm';
        return new Blob([result.buffer], { type });
    }, []);

    // Send a list recording into the Audio Editor: load its audio into the
    // waveform and seed the editor with its transcript (and speaker view).
    const loadRecordingIntoEditor = useCallback(async (recording) => {
        if (!recording.audioPath) { toast.error('Audio file path missing'); return; }
        try {
            const blob = await readRecordingBlob(recording);
            setCurrentAudioBlob(blob);
            setEditorTranscript(recording.transcription || null);
            setEditorDiarization(recording.diarization
                ? { ...recording.diarization, recordingId: recording.id }
                : null);
            document.querySelector('.recorder-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            toast.success('Loaded into editor');
        } catch (err) {
            toast.error('Error loading audio: ' + err.message);
        }
    }, [readRecordingBlob]);

    // ---------- speaker diarization ----------

    const runDiarization = useCallback(async (recording, numSpeakers) => {
        setSpeakerDialogRecording(null);
        if (!recording.audioPath) { toast.error('Audio file path missing'); return; }
        setDiarizingIds(prev => new Set(prev).add(recording.id));
        try {
            const blob = await readRecordingBlob(recording);
            const { audioArray } = await processAudioForTranscription(blob);
            const result = await window.electronAPI.diarizeRun(audioArray, numSpeakers);
            if (result?.success) {
                const ids = [...new Set(result.segments.map(s => s.speaker))].sort((a, b) => a - b);
                storageService.update(recording.id, {
                    diarization: {
                        segments: result.segments,
                        speakerNames: Object.fromEntries(ids.map((sp, i) => [String(sp), `Speaker ${i + 1}`])),
                        numSpeakersRequested: numSpeakers,
                        createdAt: new Date().toISOString(),
                    },
                });
                setRecordings(storageService.getAll());
                // Reveal the result immediately — the speaker transcript expands
                // in place under the recording row.
                setSpeakerExpandedIds(prev => new Set(prev).add(recording.id));
                toast.success(`Detected ${ids.length} speaker${ids.length === 1 ? '' : 's'} — transcript below`);
            } else {
                toast.error('Speaker detection failed: ' + (result?.error || 'Unknown error'));
            }
        } catch (err) {
            toast.error('Speaker detection error: ' + err.message);
        } finally {
            setDiarizingIds(prev => { const next = new Set(prev); next.delete(recording.id); return next; });
        }
    }, [readRecordingBlob]);

    const openSpeakersFlow = useCallback(async (recording) => {
        try {
            const status = await window.electronAPI.diarizeStatus();
            if (!status?.installed) { setDiarizeSetupState({ recording }); return; }
            setSpeakerDialogRecording(recording);
        } catch (err) {
            toast.error('Speaker detection unavailable: ' + err.message);
        }
    }, []);

    const startDiarizeSetup = useCallback(async () => {
        const recording = diarizeSetupState?.recording;
        setDiarizeSetupState({ recording, progress: { stage: 'binary', percent: 0 } });
        const unsub = window.electronAPI.onDiarizeSetupProgress((progress) => {
            setDiarizeSetupState(s => (s ? { ...s, progress } : s));
        });
        try {
            const result = await window.electronAPI.diarizeSetup();
            if (result?.success) {
                setDiarizeSetupState(null);
                setSpeakerDialogRecording(recording);
            } else {
                toast.error('Download failed: ' + (result?.error || 'Unknown error'));
                setDiarizeSetupState({ recording });
            }
        } finally {
            unsub();
        }
    }, [diarizeSetupState]);

    const renameSpeaker = useCallback((speakerId, name) => {
        if (!editorDiarization?.recordingId) return;
        const rec = storageService.getById(editorDiarization.recordingId);
        if (!rec?.diarization) return;
        const speakerNames = { ...rec.diarization.speakerNames, [String(speakerId)]: name };
        storageService.update(rec.id, { diarization: { ...rec.diarization, speakerNames } });
        setEditorDiarization(d => (d ? { ...d, speakerNames } : d));
        setRecordings(storageService.getAll());
    }, [editorDiarization]);

    const fmtClock = (secs) => `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;

    const speakerLabel = (recording, speakerId) =>
        recording.diarization?.speakerNames?.[String(speakerId)] || `Speaker ${speakerId + 1}`;

    const toggleSpeakerExpanded = useCallback((id) => {
        setSpeakerExpandedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }, []);

    // Copy the full speaker-attributed transcript, timings included.
    const copySpeakerTranscript = useCallback(async (recording) => {
        const d = recording.diarization;
        if (!d?.segments?.length) return;
        const text = d.segments
            .map(s => `${d.speakerNames?.[String(s.speaker)] || `Speaker ${s.speaker + 1}`} [${fmtClock(s.start)}–${fmtClock(s.end)}]: ${s.text}`)
            .join('\n\n');
        try {
            await navigator.clipboard.writeText(text);
            toast.success('Speaker transcript copied');
        } catch (err) {
            toast.error('Copy failed: ' + err.message);
        }
    }, []);

    const commitInlineRename = useCallback(() => {
        if (diarizeRename && diarizeRename.value.trim()) {
            const rec = storageService.getById(diarizeRename.recordingId);
            if (rec?.diarization) {
                const speakerNames = {
                    ...rec.diarization.speakerNames,
                    [String(diarizeRename.speakerId)]: diarizeRename.value.trim(),
                };
                storageService.update(rec.id, { diarization: { ...rec.diarization, speakerNames } });
                setRecordings(storageService.getAll());
            }
        }
        setDiarizeRename(null);
    }, [diarizeRename]);

    // Re-run transcription for a failed entry, in place.
    const retryTranscription = useCallback(async (recording) => {
        if (!recording.audioPath) { toast.error('Audio file path missing'); return; }
        try {
            storageService.update(recording.id, { status: 'transcribing' });
            setRecordings(storageService.getAll());
            const blob = await readRecordingBlob(recording);
            const { audioArray, durationStr } = await processAudioForTranscription(blob);
            const result = await window.electronAPI.transcribe(audioArray);
            if (result?.success && result.text) {
                storageService.update(recording.id, {
                    status: 'transcribed',
                    transcription: result.text.trim(),
                    duration: durationStr,
                });
                toast.success('Transcribed');
            } else {
                storageService.update(recording.id, { status: 'failed' });
                toast.error('Transcription failed' + (result?.error ? ': ' + result.error : ''));
            }
            setRecordings(storageService.getAll());
        } catch (err) {
            storageService.update(recording.id, { status: 'failed' });
            setRecordings(storageService.getAll());
            toast.error('Retry error: ' + err.message);
        }
    }, [readRecordingBlob]);

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
                const extension = blob.type.includes('wav')
                    ? 'wav'
                    : blob.type.includes('mpeg') || blob.type.includes('mp3')
                        ? 'mp3'
                        : 'webm';
                const saveResult = await window.electronAPI.saveAudioTemp(arrayBuffer, `recording-${Date.now()}.${extension}`);
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
        // Save any user edits in an open result panel before overwriting it,
        // same as handleTranscribe/handleRecordingComplete do.
        if (processResult) {
            dismissProcessResult();
        }
        // A done→idle timer from the previous run would reset the UI mid-run.
        if (doneTimerRef.current) {
            clearTimeout(doneTimerRef.current);
            doneTimerRef.current = null;
        }
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
            const wakeWord = settings?.wakeWord || 'quilly';

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
            doneTimerRef.current = setTimeout(() => {
                doneTimerRef.current = null;
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
    }, [processResult, dismissProcessResult]);

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
            if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
            doneTimerRef.current = setTimeout(() => {
                doneTimerRef.current = null;
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

    const handlePromptProfileChange = async (profileId) => {
        try {
            if (window.electronAPI?.developerConfigSetActive) {
                const config = await window.electronAPI.developerConfigSetActive(profileId);
                setDeveloperConfig(config);
            } else {
                await window.electronAPI.setSetting('activePromptProfileId', profileId);
                await loadDeveloperConfig();
            }
            toast.success('Configuration switched');
        } catch (err) {
            console.error('Failed to switch configuration:', err);
            toast.error('Failed to switch configuration');
        }
    };

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
                    <div className="header-actions">
                        {developerConfig?.enabled && (
                            <label className="dashboard-profile-selector">
                                <span>Configuration</span>
                                <select
                                    value={developerConfig.activeProfileId}
                                    onChange={(e) => handlePromptProfileChange(e.target.value)}
                                >
                                    {developerConfig.profiles.map(profile => (
                                        <option key={profile.id} value={profile.id}>
                                            {profile.name}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        )}
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
                        initialTranscript={editorTranscript}
                        onTranscribe={handleTranscribe}
                        onProcess={handleProcess}
                        onRecordingComplete={handleRecordingComplete}
                        isTranscribing={isTranscribing}
                        isProcessingLlm={isProcessingLlm}
                        processingState={processingState}
                        onCancelProcess={handleCancelProcess}
                        onRetryProcess={handleRetryProcess}
                        diarization={editorDiarization}
                        onRenameSpeaker={renameSpeaker}
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
                                        <td>
                                            {recording.duration}
                                            {recording.diarization?.segments?.length > 0 && (
                                                <span className="speaker-badge" title="Speakers detected">
                                                    👥 {Object.keys(recording.diarization.speakerNames || {}).length}
                                                </span>
                                            )}
                                        </td>
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
                                            {recording.diarization?.segments?.length > 0 && (
                                                <div className="speaker-inline-section">
                                                    <button
                                                        className="raw-transcription-toggle"
                                                        onClick={() => toggleSpeakerExpanded(recording.id)}
                                                    >
                                                        {speakerExpandedIds.has(recording.id)
                                                            ? 'Hide speakers'
                                                            : `Show speakers (${Object.keys(recording.diarization.speakerNames || {}).length})`}
                                                    </button>
                                                    {speakerExpandedIds.has(recording.id) && (
                                                        <div className="speaker-inline-list">
                                                            <div className="speaker-inline-actions">
                                                                <button
                                                                    className="copy-btn-inline"
                                                                    onClick={() => copySpeakerTranscript(recording)}
                                                                    title="Copy the full transcript with speaker names and timings"
                                                                >📋 Copy speaker transcript</button>
                                                            </div>
                                                            {recording.diarization.segments.map((seg, idx) => {
                                                                // Match on the clicked ROW (segIdx), not the speaker id —
                                                                // one speaker spans many rows, and rendering an autoFocus
                                                                // input in each row steals focus from the one clicked.
                                                                const isRenaming = diarizeRename
                                                                    && diarizeRename.recordingId === recording.id
                                                                    && diarizeRename.segIdx === idx;
                                                                return (
                                                                    <div key={idx} className="speaker-inline-row">
                                                                        {isRenaming ? (
                                                                            <input
                                                                                className="speaker-inline-rename"
                                                                                value={diarizeRename.value}
                                                                                autoFocus
                                                                                onChange={(e) => setDiarizeRename({ ...diarizeRename, value: e.target.value })}
                                                                                onBlur={commitInlineRename}
                                                                                onKeyDown={(e) => {
                                                                                    if (e.key === 'Enter') commitInlineRename();
                                                                                    if (e.key === 'Escape') setDiarizeRename(null);
                                                                                }}
                                                                            />
                                                                        ) : (
                                                                            <button
                                                                                className="speaker-inline-name"
                                                                                title="Click to rename this speaker"
                                                                                onClick={() => setDiarizeRename({
                                                                                    recordingId: recording.id,
                                                                                    speakerId: seg.speaker,
                                                                                    segIdx: idx,
                                                                                    value: speakerLabel(recording, seg.speaker),
                                                                                })}
                                                                            >{speakerLabel(recording, seg.speaker)}</button>
                                                                        )}
                                                                        <span className="speaker-inline-time">
                                                                            {fmtClock(seg.start)}–{fmtClock(seg.end)}
                                                                        </span>
                                                                        <span className="speaker-inline-text">{seg.text}</span>
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    )}
                                                </div>
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
                                                            const extension = recording.audioPath.split('.').pop()?.toLowerCase();
                                                            const type = extension === 'wav'
                                                                ? 'audio/wav'
                                                                : extension === 'mp3'
                                                                    ? 'audio/mpeg'
                                                                    : 'audio/webm';
                                                            const blob = new Blob([result.buffer], { type });
                                                            // Stop any previous playback and release its blob URL —
                                                            // otherwise every click leaks the full audio buffer and
                                                            // playbacks overlap.
                                                            if (playbackAudioRef.current) {
                                                                playbackAudioRef.current.pause();
                                                            }
                                                            if (playbackUrlRef.current) {
                                                                URL.revokeObjectURL(playbackUrlRef.current);
                                                            }
                                                            const url = URL.createObjectURL(blob);
                                                            const audio = new Audio(url);
                                                            playbackAudioRef.current = audio;
                                                            playbackUrlRef.current = url;
                                                            audio.onended = () => {
                                                                if (playbackUrlRef.current === url) {
                                                                    URL.revokeObjectURL(url);
                                                                    playbackUrlRef.current = null;
                                                                    playbackAudioRef.current = null;
                                                                }
                                                            };
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
                                            <button
                                                title="Edit in Audio Editor"
                                                onClick={() => loadRecordingIntoEditor(recording)}
                                                disabled={!recording.audioPath}
                                            >✎</button>
                                            <button
                                                title="Detect speakers"
                                                onClick={() => openSpeakersFlow(recording)}
                                                disabled={!recording.audioPath || diarizingIds.has(recording.id)}
                                            >{diarizingIds.has(recording.id) ? '⏳' : '👥'}</button>
                                            {recording.status === 'failed' && (
                                                <button
                                                    title="Retry transcription"
                                                    onClick={() => retryTranscription(recording)}
                                                    disabled={!recording.audioPath}
                                                >🔁</button>
                                            )}
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
                onClose={() => {
                    setIsSettingsOpen(false);
                    loadDeveloperConfig();
                }}
                deepLinkLlm={deepLinkLlm}
                onDeepLinkConsumed={() => setDeepLinkLlm(false)}
            />
            <FirstRunModal />

            {/* Speaker-count dialog (diarization) */}
            {speakerDialogRecording && (
                <div className="diarize-dialog-overlay" onClick={() => setSpeakerDialogRecording(null)}>
                    <div className="diarize-dialog" onClick={(e) => e.stopPropagation()}>
                        <h4>How many speakers?</h4>
                        <p className="diarize-dialog-hint">
                            Pick a count if you know it — detection is more accurate. Auto works when you don&apos;t.
                        </p>
                        <div className="diarize-dialog-options">
                            <button className="diarize-option primary" onClick={() => runDiarization(speakerDialogRecording, null)}>Auto</button>
                            {[2, 3, 4, 5].map(n => (
                                <button key={n} className="diarize-option" onClick={() => runDiarization(speakerDialogRecording, n)}>{n}</button>
                            ))}
                        </div>
                        <button className="diarize-dialog-cancel" onClick={() => setSpeakerDialogRecording(null)}>Cancel</button>
                    </div>
                </div>
            )}

            {/* Speaker-engine download consent + progress (diarization) */}
            {diarizeSetupState && (
                <div className="diarize-dialog-overlay" onClick={() => { if (!diarizeSetupState.progress) setDiarizeSetupState(null); }}>
                    <div className="diarize-dialog" onClick={(e) => e.stopPropagation()}>
                        <h4>Speaker detection engine</h4>
                        <p className="diarize-dialog-hint">
                            Detecting speakers needs a one-time download (~65 MB: engine + voice models). Everything runs locally.
                        </p>
                        {diarizeSetupState.progress ? (
                            <div className="diarize-setup-progress">
                                <div className="diarize-progress-track">
                                    <div
                                        className="diarize-progress-fill"
                                        style={{ width: `${diarizeSetupState.progress.percent || 0}%` }}
                                    />
                                </div>
                                <span className="diarize-progress-label">
                                    {diarizeSetupState.progress.stage === 'extracting'
                                        ? 'Extracting…'
                                        : `Downloading ${diarizeSetupState.progress.stage} — ${diarizeSetupState.progress.percent || 0}%`}
                                </span>
                            </div>
                        ) : (
                            <div className="diarize-dialog-options">
                                <button className="diarize-option primary" onClick={startDiarizeSetup}>Download</button>
                                <button className="diarize-dialog-cancel" onClick={() => setDiarizeSetupState(null)}>Cancel</button>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Toast notifications */}
            <ToastContainer />
        </div>
    );
}

export default Dashboard;
