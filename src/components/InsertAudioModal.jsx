/* eslint-disable react-hooks/set-state-in-effect */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import './InsertAudioModal.css';

function InsertAudioModal({
    isOpen,
    onClose,
    onInsert,
    segments,
    selectedSegmentIndex,
    audioDevices,
    selectedDeviceId,
    onDeviceChange,
}) {
    const [insertPosition, setInsertPosition] = useState(0);
    const [sourceMode, setSourceMode] = useState('file'); // 'file' | 'record'
    const [selectedFile, setSelectedFile] = useState(null);
    const [fileBlob, setFileBlob] = useState(null);
    const [recordedBlob, setRecordedBlob] = useState(null);
    const [isRecording, setIsRecording] = useState(false);
    const [recordingDuration, setRecordingDuration] = useState(0);

    const mediaRecorderRef = useRef(null);
    const chunksRef = useRef([]);
    const streamRef = useRef(null);
    const timerRef = useRef(null);

    // Reset state when modal opens
    useEffect(() => {
        if (isOpen) {
            setSourceMode('file');
            setSelectedFile(null);
            setFileBlob(null);
            setRecordedBlob(null);
            setIsRecording(false);
            setRecordingDuration(0);
            // Default position: after selected segment, or end
            if (selectedSegmentIndex !== null && selectedSegmentIndex >= 0) {
                setInsertPosition(selectedSegmentIndex + 1);
            } else {
                setInsertPosition(segments.length);
            }
        }
    }, [isOpen, selectedSegmentIndex, segments.length]);

    const stopRecordingCleanup = useCallback(() => {
        if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
        }
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            mediaRecorderRef.current.stop();
        }
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
            streamRef.current = null;
        }
        mediaRecorderRef.current = null;
    }, []);

    // Cleanup on unmount or close
    useEffect(() => {
        return () => {
            stopRecordingCleanup();
        };
    }, [stopRecordingCleanup]);

    const handleClose = useCallback(() => {
        stopRecordingCleanup();
        setIsRecording(false);
        onClose();
    }, [onClose, stopRecordingCleanup]);

    const handleFileSelect = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'audio/*';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (file) {
                setSelectedFile(file);
                setFileBlob(file);
            }
        };
        input.click();
    };

    const startRecording = async () => {
        try {
            const constraints = {
                audio: {
                    echoCancellation: false,
                    noiseSuppression: true,
                    autoGainControl: true,
                    ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {}),
                },
            };

            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            streamRef.current = stream;
            chunksRef.current = [];

            const mediaRecorder = new MediaRecorder(stream);
            mediaRecorderRef.current = mediaRecorder;

            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    chunksRef.current.push(e.data);
                }
            };

            mediaRecorder.onstop = () => {
                const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
                setRecordedBlob(blob);
                if (streamRef.current) {
                    streamRef.current.getTracks().forEach(track => track.stop());
                    streamRef.current = null;
                }
            };

            mediaRecorder.start(100);
            setIsRecording(true);
            setRecordedBlob(null);
            setRecordingDuration(0);

            // Start duration timer
            const startTime = Date.now();
            timerRef.current = setInterval(() => {
                setRecordingDuration((Date.now() - startTime) / 1000);
            }, 100);
        } catch (err) {
            console.error('Failed to start recording:', err);
        }
    };

    const stopRecording = () => {
        if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
        }
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            mediaRecorderRef.current.stop();
        }
        setIsRecording(false);
    };

    const handleInsert = () => {
        const blob = sourceMode === 'file' ? fileBlob : recordedBlob;
        if (blob) {
            onInsert(blob, insertPosition);
        }
    };

    const formatDuration = (seconds) => {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 10);
        return `${mins}:${String(secs).padStart(2, '0')}.${ms}`;
    };

    const canInsert = sourceMode === 'file' ? !!fileBlob : !!recordedBlob;

    // Build position options
    const positionOptions = [];
    positionOptions.push({ value: 0, label: 'Beginning' });
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const name = seg.name || `Segment ${i + 1}`;
        positionOptions.push({ value: i + 1, label: `After ${name}` });
    }

    if (!isOpen) return null;

    return (
        <div className="modal-overlay" onClick={handleClose}>
            <div className="insert-modal-content" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h2>Insert Audio</h2>
                    <button className="close-btn" onClick={handleClose}>&times;</button>
                </div>

                <div className="modal-body">
                    {/* Insert Position */}
                    <div className="insert-section">
                        <label className="insert-label">Insert Position</label>
                        <select
                            className="insert-select"
                            value={insertPosition}
                            onChange={(e) => setInsertPosition(Number(e.target.value))}
                        >
                            {positionOptions.map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                    {opt.label}
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* Source Mode Toggle */}
                    <div className="insert-section">
                        <label className="insert-label">Audio Source</label>
                        <div className="source-toggle">
                            <button
                                className={`source-btn ${sourceMode === 'file' ? 'active' : ''}`}
                                onClick={() => setSourceMode('file')}
                                disabled={isRecording}
                            >
                                From File
                            </button>
                            <button
                                className={`source-btn ${sourceMode === 'record' ? 'active' : ''}`}
                                onClick={() => setSourceMode('record')}
                                disabled={isRecording}
                            >
                                Record New
                            </button>
                        </div>
                    </div>

                    {/* File Source */}
                    {sourceMode === 'file' && (
                        <div className="insert-section">
                            <button className="choose-file-btn" onClick={handleFileSelect}>
                                Choose Audio File
                            </button>
                            {selectedFile && (
                                <div className="file-info">
                                    <span className="file-name">{selectedFile.name}</span>
                                    <span className="file-size">
                                        ({(selectedFile.size / 1024).toFixed(1)} KB)
                                    </span>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Record Source */}
                    {sourceMode === 'record' && (
                        <div className="insert-section">
                            {audioDevices.length > 0 && (
                                <select
                                    className="insert-select mic-select"
                                    value={selectedDeviceId}
                                    onChange={(e) => onDeviceChange(e.target.value)}
                                    disabled={isRecording}
                                >
                                    {audioDevices.map(device => (
                                        <option key={device.deviceId} value={device.deviceId}>
                                            {device.label || `Microphone ${device.deviceId.slice(0, 8)}`}
                                        </option>
                                    ))}
                                </select>
                            )}
                            <div className="record-controls">
                                {!isRecording ? (
                                    <button className="record-btn" onClick={startRecording}>
                                        Record
                                    </button>
                                ) : (
                                    <button className="record-btn recording" onClick={stopRecording}>
                                        Stop ({formatDuration(recordingDuration)})
                                    </button>
                                )}
                            </div>
                            {recordedBlob && !isRecording && (
                                <div className="file-info">
                                    <span className="file-name">
                                        Recording ready ({formatDuration(recordingDuration)})
                                    </span>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <div className="modal-footer">
                    <button className="btn-secondary" onClick={handleClose}>
                        Cancel
                    </button>
                    <button
                        className="btn-primary"
                        onClick={handleInsert}
                        disabled={!canInsert || isRecording}
                    >
                        Insert
                    </button>
                </div>
            </div>
        </div>
    );
}

export default InsertAudioModal;
