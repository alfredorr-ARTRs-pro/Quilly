import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { processAudioForTranscription } from '../utils/audioProcessing';
import './Indicator.css';

function Indicator() {
    const [phase, setPhase] = useState('idle'); // 'idle' | 'preparing' | 'recording' | 'transcribing' | 'llm-processing' | 'done'
    const [elapsedSeconds, setElapsedSeconds] = useState(0);
    const [showFirstUsePrompt, setShowFirstUsePrompt] = useState(false);
    const [chainStepText, setChainStepText] = useState(null); // e.g. "Step 1/2: Translating..."
    const [llmMode, setLlmMode] = useState(false); // true when LLM hotkey was used to stop recording
    const [liveAudioLevel, setLiveAudioLevel] = useState(0);
    const timerRef = useRef(null);
    const mediaRecorderRef = useRef(null);
    const chunksRef = useRef([]);
    const streamRef = useRef(null);
    const audioContextRef = useRef(null);
    const audioSourceRef = useRef(null);
    const audioProcessorRef = useRef(null);
    const lastLevelUpdateRef = useRef(0);
    const clickCoordsRef = useRef(null);
    const timeoutRef = useRef(null);
    const llmUnsubRef = useRef(null);
    const firstUseAutoTimerRef = useRef(null);

    // Recording timer — resets to zero each time phase enters 'recording'
    useEffect(() => {
        if (phase === 'recording') {
            timerRef.current = setInterval(() => {
                setElapsedSeconds(s => s + 1);
            }, 1000);
        } else {
            clearInterval(timerRef.current);
        }
        return () => clearInterval(timerRef.current);
    }, [phase]);

    const formattedTime = useMemo(() => {
        const m = Math.floor(elapsedSeconds / 60);
        const s = String(elapsedSeconds % 60).padStart(2, '0');
        return `${m}:${s}`;
    }, [elapsedSeconds]);

    // ---------- mic stream management ----------

    const stopPcmCapture = useCallback(() => {
        if (audioProcessorRef.current) {
            audioProcessorRef.current.disconnect();
            audioProcessorRef.current.onaudioprocess = null;
            audioProcessorRef.current = null;
        }
        if (audioSourceRef.current) {
            audioSourceRef.current.disconnect();
            audioSourceRef.current = null;
        }
        if (audioContextRef.current) {
            audioContextRef.current.close().catch(() => {});
            audioContextRef.current = null;
        }
    }, []);

    const releaseStream = useCallback(() => {
        stopPcmCapture();
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
            streamRef.current = null;
        }
    }, [stopPcmCapture]);



    /** Return a fresh live audio stream. */
    const ensureStream = useCallback(async () => {
        // Always release any dangling stream first
        releaseStream();
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: false,
                noiseSuppression: true,
                autoGainControl: true,
            }
        });
        streamRef.current = stream;
        return stream;
    }, [releaseStream]);

    const resetAudioMeter = useCallback(() => {
        setLiveAudioLevel(0);
    }, []);

    const appendPcmChunk = useCallback((chunk) => {
        let peak = 0;
        for (let i = 0; i < chunk.length; i++) {
            const value = Math.abs(chunk[i]);
            if (value > peak) peak = value;
        }

        const now = performance.now();
        if (now - lastLevelUpdateRef.current > 80) {
            lastLevelUpdateRef.current = now;
            setLiveAudioLevel(prev => (prev * 0.55) + (Math.min(1, peak * 16) * 0.45));
        }
    }, []);

    const startPcmCapture = useCallback((stream) => {
        stopPcmCapture();
        resetAudioMeter();

        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextCtor) return false;

        const audioContext = new AudioContextCtor();
        const source = audioContext.createMediaStreamSource(stream);
        const processor = audioContext.createScriptProcessor(4096, 1, 1);

        processor.onaudioprocess = (event) => {
            const input = event.inputBuffer.getChannelData(0);
            appendPcmChunk(input);
        };

        source.connect(processor);
        processor.connect(audioContext.destination);

        audioContextRef.current = audioContext;
        audioSourceRef.current = source;
        audioProcessorRef.current = processor;

        if (audioContext.state === 'suspended') {
            audioContext.resume().catch(err => {
                console.warn('[Indicator] audio meter resume failed:', err);
            });
        }

        return true;
    }, [appendPcmChunk, resetAudioMeter, stopPcmCapture]);

    // ---------- transcription ----------

    const transcribeAudio = async (audioBlob) => {
        try {
            const { audioArray, durationStr } = await processAudioForTranscription(audioBlob);
            const result = await window.electronAPI.transcribe(audioArray);

            if (result.success && result.text) {
                return { text: result.text.trim(), duration: durationStr, audioArray };
            }
            // success:false carries an engine error worth surfacing; success
            // with empty text is just silence — stay quiet for that.
            if (result && result.success === false && result.error) {
                return { error: result.error };
            }
            return null;
        } catch (err) {
            console.error('Transcription error:', err);
            return { error: err.message };
        }
    };


    // ---------- LLM status listener ----------

    useEffect(() => {
        if (!window.electronAPI?.onLlmStatus) return;

        const unsub = window.electronAPI.onLlmStatus((payload) => {
            const status = payload?.status ?? payload;
            if (status === 'processing' || status === 'loading-model') {
                setPhase('llm-processing');
                // Show chain step progress text if provided ("Step 1/2: Translating...")
                if (payload?.chainStep != null && payload?.chainTotal != null) {
                    setChainStepText(`Step ${payload.chainStep}/${payload.chainTotal}: ${payload.stepLabel || 'Processing...'}`);
                } else {
                    setChainStepText(null);
                }
                // Reset the 120s safety timeout each time a status event arrives
                clearTimeout(timeoutRef.current);
                timeoutRef.current = setTimeout(() => {
                    console.warn('[Indicator] LLM timeout — no status update for 120s, resetting');
                    setPhase('idle');
                    setChainStepText(null);
                    window.electronAPI?.hideIndicator?.();
                }, 120_000);
            } else if (status === 'idle') {
                // LLM finished — clear timeout, transcriptionComplete IPC handles done/idle
                clearTimeout(timeoutRef.current);
                setChainStepText(null);
            }
        });

        llmUnsubRef.current = unsub;

        return () => {
            unsub?.();
            clearTimeout(timeoutRef.current);
        };
    }, []);

    // ---------- cancel handler ----------

    const handleCancelLlm = useCallback(() => {
        clearTimeout(timeoutRef.current);
        setPhase('idle');
        window.electronAPI?.hideIndicator?.();
    }, []);

    // ---------- first-use prompt handlers ----------

    const handleDismissFirstUse = useCallback(async () => {
        clearTimeout(firstUseAutoTimerRef.current);
        setShowFirstUsePrompt(false);
        // Re-enable pass-through mouse events on indicator
        await window.electronAPI?.llmSetIndicatorInteractive?.(false);
        // Persist dismissal so it never shows again
        try {
            await window.electronAPI?.setSetting?.('llmFirstUsePromptDismissed', true);
        } catch (e) {
            console.error('[Indicator] Failed to persist first-use dismissal:', e);
        }
        // Hide indicator now that the prompt is dismissed
        window.electronAPI?.hideIndicator?.();
    }, []);

    const handleDownloadNow = useCallback(async () => {
        clearTimeout(firstUseAutoTimerRef.current);
        setShowFirstUsePrompt(false);
        // Re-enable pass-through mouse events on indicator
        await window.electronAPI?.llmSetIndicatorInteractive?.(false);
        // Persist dismissal
        try {
            await window.electronAPI?.setSetting?.('llmFirstUsePromptDismissed', true);
        } catch (e) {
            console.error('[Indicator] Failed to persist first-use dismissal:', e);
        }
        // Open main window for model setup
        await window.electronAPI?.llmOpenSetup?.();
        // Hide indicator since we're redirecting user
        window.electronAPI?.hideIndicator?.();
    }, []);

    // Subscribe to first-use prompt IPC event
    useEffect(() => {
        if (!window.electronAPI?.onLlmFirstUsePrompt) return;

        const unsub = window.electronAPI.onLlmFirstUsePrompt(() => {
            setShowFirstUsePrompt(true);
            // Enable mouse events so the user can click buttons
            window.electronAPI?.llmSetIndicatorInteractive?.(true);
            // Auto-dismiss after 15 seconds if user doesn't interact
            clearTimeout(firstUseAutoTimerRef.current);
            firstUseAutoTimerRef.current = setTimeout(() => {
                setShowFirstUsePrompt(prev => {
                    if (prev) {
                        // Auto-dismiss: persist and hide
                        window.electronAPI?.llmSetIndicatorInteractive?.(false);
                        window.electronAPI?.setSetting?.('llmFirstUsePromptDismissed', true).catch(() => {});
                        window.electronAPI?.hideIndicator?.();
                    }
                    return false;
                });
            }, 15000);
        });

        return () => {
            unsub?.();
            clearTimeout(firstUseAutoTimerRef.current);
        };
    }, []);

    // ---------- recording ----------

    const startRecording = useCallback(async () => {
        // Immediately reset phase so stale UI (e.g. green checkmark from a
        // previous recording) is cleared before the window becomes visible.
        setPhase('idle');
        setElapsedSeconds(0);

        try {
            // Get microphone stream directly from OS
            const stream = await ensureStream();
            setLiveAudioLevel(0);

            startPcmCapture(stream);

            const mediaRecorder = new MediaRecorder(stream);
            mediaRecorderRef.current = mediaRecorder;
            chunksRef.current = [];

            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    chunksRef.current.push(e.data);
                }
            };

            mediaRecorder.onstop = async () => {
                setPhase('transcribing');
                const audioBlob = new Blob(chunksRef.current, { type: 'audio/webm' });

                // Instantly kill the hardware stream so the OS indicator goes away
                releaseStream();

                // SAVE-FIRST: persist the audio and create a placeholder history
                // entry BEFORE transcription. A long or failed transcription must
                // never lose the recording — the entry stays in the list with its
                // audio and can be retried or opened in the editor.
                const recordingId = (typeof crypto !== 'undefined' && crypto.randomUUID)
                    ? crypto.randomUUID()
                    : ('rec-' + Date.now());
                let audioPath = null;
                try {
                    const arrayBuffer = await audioBlob.arrayBuffer();
                    const saveResult = await window.electronAPI.saveAudioTemp(arrayBuffer, `${recordingId}.webm`);
                    if (saveResult.success) {
                        audioPath = saveResult.path;
                    }
                } catch (e) {
                    console.error('Failed to save recording audio:', e);
                }
                try {
                    await window.electronAPI.saveToHistory?.({
                        id: recordingId,
                        name: `Voice Recording ${new Date().toLocaleTimeString()}`,
                        status: 'transcribing',
                        transcription: null,
                        audioPath,
                    });
                } catch (e) {
                    console.error('Failed to create placeholder history entry:', e);
                }

                const result = await transcribeAudio(audioBlob);

                if (result?.text) {
                    const coords = clickCoordsRef.current;

                    // Show success checkmark for 1.5s so user can see it
                    setPhase('done');
                    clearTimeout(timeoutRef.current);

                    setTimeout(async () => {
                        clickCoordsRef.current = null;
                        const ipcResult = await window.electronAPI.transcriptionComplete(
                            result.text, coords?.x || 0, coords?.y || 0, result.audioArray, audioPath,
                            { recordingId, duration: result.duration }
                        );
                        // When review-first blocks paste, main.cjs fills in this
                        // entry on the popup outcome (via update-recording keyed by
                        // recordingId) — so skip the update here to avoid a race.
                        if (!ipcResult?.shouldBlockPaste) {
                            const displayText = ipcResult?.pastedText || result.text;
                            const isLlm = ipcResult?.llmProcessed || false;
                            await window.electronAPI.updateRecording?.(recordingId, {
                                status: 'transcribed',
                                duration: result.duration,
                                transcription: displayText,
                                rawTranscription: (isLlm || (result.text && result.text !== displayText)) ? result.text : null,
                                processedResult: isLlm ? (ipcResult?.processedResult || null) : null,
                                intentLabels: isLlm ? (ipcResult?.intentLabels || []) : [],
                            });
                        }
                    }, 1500);
                } else if (result?.error) {
                    // Engine failure: audio is already saved, so mark the entry
                    // failed (retryable from the list) and show a brief ✕. main.cjs
                    // raises a notification with the full reason.
                    await window.electronAPI.updateRecording?.(recordingId, { status: 'failed' });
                    setPhase('error');
                    clearTimeout(timeoutRef.current);
                    setTimeout(() => {
                        setPhase('idle');
                        window.electronAPI?.hideIndicator?.();
                        clickCoordsRef.current = null;
                    }, 2500);
                } else {
                    // No speech detected (or empty result): mark failed so the audio
                    // stays available to retry, then hide quietly.
                    await window.electronAPI.updateRecording?.(recordingId, { status: 'failed' });
                    setPhase('idle');
                    clearTimeout(timeoutRef.current);
                    window.electronAPI?.hideIndicator?.();
                    clickCoordsRef.current = null;
                }
            };

            // Mic is now live — start capturing chunks
            mediaRecorder.start(100);

            // Show the "Preparing" hourglass. The mic IS recording during
            // this phase — the 1.5 s warmup is purely a visual buffer so
            // the user waits for the red mic icon before speaking.
            setPhase('preparing');

            setTimeout(() => {
                setPhase(current => current === 'preparing' ? 'recording' : current);
            }, 1500);

        } catch (err) {
            console.error('Failed to start recording:', err);
            setPhase('idle');
            // Otherwise the bubble sits on screen with nothing recording.
            window.electronAPI?.recordingStartFailed?.(err?.name, err?.message)?.catch?.(() => {});
        }
    }, [ensureStream, releaseStream, startPcmCapture]);

    const stopRecording = useCallback((coords) => {
        clickCoordsRef.current = coords;
        setLlmMode(!!coords?.llmMode);
        if (mediaRecorderRef.current?.state === 'recording') {
            mediaRecorderRef.current.stop();
        }
    }, []);

    // ---------- IPC listeners ----------

    useEffect(() => {
        console.log('Indicator mounted, electronAPI available:', !!window.electronAPI);
        if (!window.electronAPI) return;

        const unsubStart = window.electronAPI.onStartRecording(() => {
            console.log('Indicator: received start-recording');
            startRecording();
        });

        const unsubStop = window.electronAPI.onStopRecording((coords) => {
            console.log('Indicator: received stop-recording', coords);
            stopRecording(coords);
        });

        // Main process sends this when the indicator is hidden so the
        // phase resets for the next recording cycle.
        const unsubReset = window.electronAPI.onResetIndicator?.(() => {
            setPhase('idle');
            setChainStepText(null);
            setLiveAudioLevel(0);
            clearTimeout(timeoutRef.current);
        });

        return () => {
            unsubStart?.();
            unsubStop?.();
            unsubReset?.();
        };
    }, [startRecording, stopRecording]);

    // Clean up stream on unmount
    useEffect(() => {
        return () => {
            releaseStream();
            clearTimeout(timeoutRef.current);
        };
    }, [releaseStream]);

    // When the first-use prompt is active, render it instead of the normal indicator
    if (showFirstUsePrompt) {
        return (
            <div className="first-use-prompt">
                <div className="first-use-content">
                    <svg className="icon brain-icon-static" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/>
                        <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/>
                    </svg>
                    <div className="first-use-text">
                        <span className="first-use-title">Quilly needs a brain!</span>
                        <span className="first-use-subtitle">Download an AI model to unlock text rewriting</span>
                    </div>
                    <button className="first-use-cta" onClick={handleDownloadNow}>Download now</button>
                    <button className="first-use-dismiss" onClick={handleDismissFirstUse}>&times;</button>
                </div>
            </div>
        );
    }

    const pulseScale = Math.max(0.85, Math.min(1.85, 0.85 + liveAudioLevel));
    const pulseOpacity = Math.max(0.35, Math.min(1, 0.35 + liveAudioLevel * 0.65));

    const llmProcessingClass = phase === 'llm-processing'
        ? (chainStepText ? ' llm-processing-chain' : '')
        : '';

    return (
        <div className={`indicator ${phase}${llmProcessingClass}`}>
            <div className="indicator-main-row">
            {phase === 'idle' && <div className="icon"></div>}
            {phase === 'preparing' && (
                <svg className="icon hourglass-icon" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M6 2v6h.01L6 8.01 10 12l-4 4 .01.01H6V22h12v-5.99h-.01L18 16l-4-4 4-3.99-.01-.01H18V2H6zm10 14.5V20H8v-3.5l4-4 4 4z" />
                </svg>
            )}
            {phase === 'recording' && (
                <>
                    <svg className="icon mic-icon" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                        <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                    </svg>
                    <span className="timer">{formattedTime}</span>
                    <span
                        className="audio-pulse-dot"
                        aria-hidden="true"
                        style={{
                            opacity: pulseOpacity,
                            transform: `scale(${pulseScale})`,
                        }}
                    />
                </>
            )}

            {phase === 'transcribing' && (
                <>
                    <svg className="icon quill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z" />
                        <line x1="16" y1="8" x2="2" y2="22" />
                        <line x1="17.5" y1="15" x2="9" y2="15" />
                    </svg>
                    {llmMode && <span className="llm-badge">LLM</span>}
                </>
            )}

            {phase === 'llm-processing' && (
                <>
                    <svg className="icon brain-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                         onClick={handleCancelLlm} style={{ cursor: 'pointer' }}
                         title="Click to cancel">
                        <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/>
                        <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/>
                    </svg>
                    {chainStepText && (
                        <span className="chain-step-text">{chainStepText}</span>
                    )}
                </>
            )}

            {phase === 'done' && (
                <svg className="icon check-icon" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
                </svg>
            )}

            {phase === 'error' && (
                <svg className="icon error-icon" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z" />
                </svg>
            )}
            </div>
        </div>
    );
}

export default Indicator;
