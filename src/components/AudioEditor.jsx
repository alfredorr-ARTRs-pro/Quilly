import React, { useRef, useEffect, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';
import { toast } from './Toast';
import InsertAudioModal from './InsertAudioModal';
import './AudioEditor.css';

// Segment represents a portion of the edited audio with reference to original
// { id: string, originalStart: number, originalEnd: number, name: string, isInstruction: boolean }
// The waveform always shows the current edited state

// Zoom presets in pixels per second (higher = more zoomed in)
const ZOOM_PRESETS = [
    { label: '10s', value: 50, description: '10 seconds view' },
    { label: '5s', value: 100, description: '5 seconds view' },
    { label: '2s', value: 250, description: '2 seconds view' },
    { label: '1s', value: 500, description: '1 second view' },
    { label: '500ms', value: 1000, description: '500ms view' },
    { label: '200ms', value: 2500, description: '200ms view' },
    { label: '100ms', value: 5000, description: '100ms precision' },
    { label: '50ms', value: 10000, description: '50ms precision' },
];

// Convert AudioBuffer to WAV Blob
function audioBufferToWavBlob(audioBuffer) {
    const numberOfChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const format = 1; // PCM
    const bitDepth = 16;

    const bytesPerSample = bitDepth / 8;
    const blockAlign = numberOfChannels * bytesPerSample;
    const dataLength = audioBuffer.length * blockAlign;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    // Write WAV header
    const writeString = (offset, str) => {
        for (let i = 0; i < str.length; i++) {
            view.setUint8(offset + i, str.charCodeAt(i));
        }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numberOfChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeString(36, 'data');
    view.setUint32(40, dataLength, true);

    // Interleave and write audio data
    let offset = 44;
    for (let i = 0; i < audioBuffer.length; i++) {
        for (let channel = 0; channel < numberOfChannels; channel++) {
            const sample = Math.max(-1, Math.min(1, audioBuffer.getChannelData(channel)[i]));
            view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
            offset += 2;
        }
    }

    return new Blob([buffer], { type: 'audio/wav' });
}

const AudioEditor = forwardRef(({ audioBlob, onTranscribe, onProcess, onRecordingComplete, isTranscribing, isProcessingLlm, processingState, onCancelProcess, onRetryProcess }, ref) => {
    const containerRef = useRef(null);
    const wavesurferRef = useRef(null);
    const regionsRef = useRef(null);
    const mediaRecorderRef = useRef(null);
    const chunksRef = useRef([]);
    const internalBlobRef = useRef(null);
    const originalAudioBufferRef = useRef(null);  // Store the ORIGINAL decoded audio buffer (never modified)
    const currentAudioBufferRef = useRef(null);   // Store the CURRENT edited audio buffer
    const sharedAudioCtxRef = useRef(null);       // Shared AudioContext to avoid repeated alloc/dealloc

    // Reuse a single AudioContext across all operations (createBuffer, decodeAudioData).
    // Creating/closing separate contexts per operation is expensive — each allocates OS audio resources.
    const getAudioContext = useCallback(async () => {
        if (!sharedAudioCtxRef.current || sharedAudioCtxRef.current.state === 'closed') {
            sharedAudioCtxRef.current = new AudioContext();
        }
        if (sharedAudioCtxRef.current.state === 'suspended') {
            await sharedAudioCtxRef.current.resume();
        }
        return sharedAudioCtxRef.current;
    }, []);

    const [isPlaying, setIsPlaying] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [duration, setDuration] = useState(0);
    const [currentTime, setCurrentTime] = useState(0);
    const [hasAudio, setHasAudio] = useState(false);
    const [audioDevices, setAudioDevices] = useState([]);
    const [selectedDeviceId, setSelectedDeviceId] = useState('');

    // Segment-based editing state
    const [segments, setSegments] = useState([]);  // Array of segments referencing original audio: { id, originalStart, originalEnd, name }
    const [selectedSegmentIndex, setSelectedSegmentIndex] = useState(null);
    const [cursorPosition, setCursorPosition] = useState(0);  // Position in timeline for split
    const [draggedSegmentIndex, setDraggedSegmentIndex] = useState(null);
    const [dragOverIndex, setDragOverIndex] = useState(null);
    const [isProcessing, setIsProcessing] = useState(false);  // Show loading during audio regeneration

    // Zoom state - pixels per second
    const [zoomLevel, setZoomLevel] = useState(100);  // Default 100px per second
    const [editingSegmentName, setEditingSegmentName] = useState(null);  // Index of segment being renamed
    const [editingNameValue, setEditingNameValue] = useState('');  // Current name input value
    const [projectName, setProjectName] = useState('');  // Name for save/load
    const [isInsertModalOpen, setIsInsertModalOpen] = useState(false);  // Insert audio modal

    // Generate unique ID for segments
    const generateId = () => `seg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

    // Apply zoom to waveform
    const applyZoom = useCallback((level) => {
        if (wavesurferRef.current) {
            wavesurferRef.current.zoom(level);
        }
        setZoomLevel(level);
    }, []);

    // Zoom in/out handlers
    const handleZoomIn = useCallback(() => {
        const currentIndex = ZOOM_PRESETS.findIndex(p => p.value === zoomLevel);
        if (currentIndex < ZOOM_PRESETS.length - 1) {
            applyZoom(ZOOM_PRESETS[currentIndex + 1].value);
        } else if (currentIndex === -1) {
            // Find nearest higher preset
            const higher = ZOOM_PRESETS.find(p => p.value > zoomLevel);
            if (higher) applyZoom(higher.value);
        }
    }, [zoomLevel, applyZoom]);

    const handleZoomOut = useCallback(() => {
        const currentIndex = ZOOM_PRESETS.findIndex(p => p.value === zoomLevel);
        if (currentIndex > 0) {
            applyZoom(ZOOM_PRESETS[currentIndex - 1].value);
        } else if (currentIndex === -1) {
            // Find nearest lower preset
            const lower = [...ZOOM_PRESETS].reverse().find(p => p.value < zoomLevel);
            if (lower) applyZoom(lower.value);
        }
    }, [zoomLevel, applyZoom]);

    // Get current zoom label
    const getCurrentZoomLabel = useCallback(() => {
        const preset = ZOOM_PRESETS.find(p => p.value === zoomLevel);
        return preset ? preset.label : `${Math.round(1000 / zoomLevel * 100) / 100}s`;
    }, [zoomLevel]);

    // Clear all audio and segments
    const clearAll = useCallback(() => {
        if (wavesurferRef.current) {
            wavesurferRef.current.empty();
        }
        if (regionsRef.current) {
            regionsRef.current.clearRegions();
        }
        setHasAudio(false);
        setDuration(0);
        setCurrentTime(0);
        setSegments([]);
        setSelectedSegmentIndex(null);
        setCursorPosition(0);
        originalAudioBufferRef.current = null;
        currentAudioBufferRef.current = null;
        internalBlobRef.current = null;
    }, []);

    // Expose methods to parent
    useImperativeHandle(ref, () => ({
        clear: clearAll,
        getAudioBlob: async () => {
            // Return the current edited audio blob
            const blob = internalBlobRef.current || audioBlob;
            console.log('AudioEditor getAudioBlob:', blob ? `Blob size: ${blob.size}, type: ${blob.type}` : 'null');
            return blob;
        },
        // PROC-01/PROC-02/PROC-03: Return per-segment audio blobs with instruction metadata.
        // Each element: { blob: Blob, isInstruction: boolean }
        // Renders each segment individually from the original buffer so the caller
        // can transcribe each segment separately and assemble the instruction text.
        getSegmentsForProcessing: async () => {
            const orig = originalAudioBufferRef.current;
            const segs = segmentsRef.current;
            if (!orig || segs.length === 0) return null;
            const result = [];
            for (const seg of segs) {
                // Render this single segment to its own AudioBuffer
                const sampleRate = orig.sampleRate;
                const numberOfChannels = orig.numberOfChannels;
                const startSample = Math.floor(seg.originalStart * sampleRate);
                const endSample = Math.floor(seg.originalEnd * sampleRate);
                const segLength = endSample - startSample;
                if (segLength <= 0) continue;
                const audioCtx = await getAudioContext();
                const segBuffer = audioCtx.createBuffer(numberOfChannels, segLength, sampleRate);
                for (let ch = 0; ch < numberOfChannels; ch++) {
                    const dest = segBuffer.getChannelData(ch);
                    const src = orig.getChannelData(ch);
                    for (let i = 0; i < segLength; i++) {
                        dest[i] = src[startSample + i];
                    }
                }
                const blob = audioBufferToWavBlob(segBuffer);
                result.push({ blob, isInstruction: !!seg.isInstruction });
            }
            return result.length > 0 ? result : null;
        },
    }));

    // Resample an AudioBuffer to match target sample rate and channel count
    const resampleBuffer = useCallback(async (sourceBuffer, targetSampleRate, targetChannels) => {
        if (sourceBuffer.sampleRate === targetSampleRate && sourceBuffer.numberOfChannels === targetChannels) {
            return sourceBuffer;
        }
        const duration = sourceBuffer.duration;
        const offlineCtx = new OfflineAudioContext(
            targetChannels,
            Math.ceil(duration * targetSampleRate),
            targetSampleRate
        );
        const source = offlineCtx.createBufferSource();
        source.buffer = sourceBuffer;
        source.connect(offlineCtx.destination);
        source.start();
        return await offlineCtx.startRendering();
    }, []);

    // Append new audio to the original buffer, returns time offsets for the appended region
    const appendToOriginalBuffer = useCallback(async (newAudioBuffer) => {
        const original = originalAudioBufferRef.current;
        const sampleRate = original.sampleRate;
        const numberOfChannels = original.numberOfChannels;

        // Resample if needed
        const processedBuffer = await resampleBuffer(newAudioBuffer, sampleRate, numberOfChannels);

        // Create concatenated buffer
        const totalSamples = original.length + processedBuffer.length;
        const audioCtx = await getAudioContext();
        const combinedBuffer = audioCtx.createBuffer(numberOfChannels, totalSamples, sampleRate);

        for (let ch = 0; ch < numberOfChannels; ch++) {
            const destData = combinedBuffer.getChannelData(ch);
            const srcOriginal = original.getChannelData(ch);
            const srcNew = processedBuffer.getChannelData(ch);
            destData.set(srcOriginal, 0);
            destData.set(srcNew, original.length);
        }

        const appendedStartTime = original.duration;
        const appendedEndTime = combinedBuffer.duration;

        // Replace original buffer with extended version
        originalAudioBufferRef.current = combinedBuffer;

        return { appendedStartTime, appendedEndTime };
    }, [resampleBuffer, getAudioContext]);

    // Render segments to a new AudioBuffer (for waveform display)
    const renderSegmentsToBuffer = useCallback(async (segs) => {
        if (!originalAudioBufferRef.current || segs.length === 0) return null;

        const originalBuffer = originalAudioBufferRef.current;
        const sampleRate = originalBuffer.sampleRate;
        const numberOfChannels = originalBuffer.numberOfChannels;

        // Calculate total samples needed
        let totalSamples = 0;
        for (const seg of segs) {
            const startSample = Math.floor(seg.originalStart * sampleRate);
            const endSample = Math.floor(seg.originalEnd * sampleRate);
            totalSamples += endSample - startSample;
        }

        if (totalSamples === 0) return null;

        // Create new buffer for edited audio
        const audioCtx = await getAudioContext();
        const newBuffer = audioCtx.createBuffer(numberOfChannels, totalSamples, sampleRate);

        // Copy each segment into the new buffer
        let writeOffset = 0;
        for (const seg of segs) {
            const startSample = Math.floor(seg.originalStart * sampleRate);
            const endSample = Math.floor(seg.originalEnd * sampleRate);
            const segLength = endSample - startSample;

            for (let ch = 0; ch < numberOfChannels; ch++) {
                const destData = newBuffer.getChannelData(ch);
                const srcData = originalBuffer.getChannelData(ch);
                for (let i = 0; i < segLength; i++) {
                    destData[writeOffset + i] = srcData[startSample + i];
                }
            }
            writeOffset += segLength;
        }

        return newBuffer;
    }, [getAudioContext]);




    // Update visual split markers on waveform (thin lines at segment boundaries)
    const updateSplitMarkers = useCallback((segs) => {
        if (!regionsRef.current) return;

        regionsRef.current.clearRegions();

        // Draw instruction segment regions first (background layer)
        let instructionTime = 0;
        for (let i = 0; i < segs.length; i++) {
            const segDuration = segs[i].originalEnd - segs[i].originalStart;
            if (segs[i].isInstruction) {
                regionsRef.current.addRegion({
                    id: `instruction-region-${segs[i].id}`,
                    start: instructionTime,
                    end: instructionTime + segDuration,
                    color: 'rgba(251, 146, 60, 0.25)',  // amber-400 at 25% opacity
                    drag: false,
                    resize: false,
                });
            }
            instructionTime += segDuration;
        }

        if (segs.length <= 1) return;

        // Draw thin split markers at boundaries (on top)
        let currentTime = 0;
        for (let i = 0; i < segs.length - 1; i++) {
            const segDuration = segs[i].originalEnd - segs[i].originalStart;
            currentTime += segDuration;

            regionsRef.current.addRegion({
                id: `split-marker-${i}`,
                start: currentTime - 0.01,
                end: currentTime + 0.01,
                color: 'rgba(255, 107, 107, 0.8)',
                drag: false,
                resize: false,
            });
        }
    }, []);

    // Regenerate waveform from current segments (called after edits)
    const regenerateWaveform = useCallback(async (newSegments) => {
        if (!originalAudioBufferRef.current || newSegments.length === 0 || !wavesurferRef.current) return;

        setIsProcessing(true);
        try {
            // Render segments to new buffer
            const newBuffer = await renderSegmentsToBuffer(newSegments);
            if (!newBuffer) {
                setIsProcessing(false);
                return;
            }

            currentAudioBufferRef.current = newBuffer;

            // Convert to blob and reload waveform
            const newBlob = audioBufferToWavBlob(newBuffer);
            internalBlobRef.current = newBlob;

            const url = URL.createObjectURL(newBlob);
            await wavesurferRef.current.load(url);
            URL.revokeObjectURL(url);

            // Update duration
            setDuration(newBuffer.duration);

            // Add region markers to show segment boundaries
            updateSplitMarkers(newSegments, newBuffer.duration);

        } catch (err) {
            console.error('Failed to regenerate waveform:', err);
            toast.error('Failed to update waveform');
        }
        setIsProcessing(false);
    }, [renderSegmentsToBuffer, updateSplitMarkers]);



    // Store segments in a ref so we can access current value in event handlers without re-creating WaveSurfer
    const segmentsRef = useRef(segments);
    useEffect(() => {
        // eslint-disable-next-line react-hooks/immutability -- standard "latest ref" pattern; ref intentionally tracks state
        segmentsRef.current = segments;
    }, [segments]);

    // Initialize WaveSurfer - only once on mount
    useEffect(() => {
        if (!containerRef.current) return;

        const regions = RegionsPlugin.create();
        regionsRef.current = regions;

        const ws = WaveSurfer.create({
            container: containerRef.current,
            waveColor: 'rgba(102, 126, 234, 0.5)',
            progressColor: '#667eea',
            cursorColor: '#764ba2',
            barWidth: 2,
            barGap: 1,
            barRadius: 2,
            height: 100,
            normalize: true,
            plugins: [regions],
        });

        ws.on('ready', () => {
            const dur = ws.getDuration();
            setDuration(dur);
            setHasAudio(true);
        });

        ws.on('audioprocess', () => {
            setCurrentTime(ws.getCurrentTime());
        });

        ws.on('play', () => setIsPlaying(true));
        ws.on('pause', () => setIsPlaying(false));
        ws.on('finish', () => setIsPlaying(false));

        // Click on waveform to set cursor position for splitting (no segment selection here)
        ws.on('click', (relativeX) => {
            const clickTime = relativeX * ws.getDuration();
            setCursorPosition(clickTime);
        });

        // Region clicks should also set cursor position (markers are just visual, pass through)
        regions.on('region-clicked', (region, e) => {
            // Don't stop propagation - let the waveform click handle cursor position
            // The markers are just visual guides
            if (ws && ws.getDuration() > 0) {
                const waveformRect = containerRef.current.getBoundingClientRect();
                const clickX = e.clientX - waveformRect.left;
                const relativeX = clickX / waveformRect.width;
                const clickTime = relativeX * ws.getDuration();
                setCursorPosition(clickTime);
            }
        });

        wavesurferRef.current = ws;

        return () => {
            ws.destroy();
            if (sharedAudioCtxRef.current && sharedAudioCtxRef.current.state !== 'closed') {
                sharedAudioCtxRef.current.close();
                sharedAudioCtxRef.current = null;
            }
        };
    }, []);  // Empty dependency array - only run once on mount

    // Load audio when blob changes
    useEffect(() => {
        if (audioBlob && wavesurferRef.current) {
            const url = URL.createObjectURL(audioBlob);
            wavesurferRef.current.load(url);

            // Decode and store audio buffer for editing
            const decodeAudio = async () => {
                try {
                    const arrayBuffer = await audioBlob.arrayBuffer();
                    const audioCtx = await getAudioContext();
                    const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);
                    originalAudioBufferRef.current = decodedBuffer;
                    currentAudioBufferRef.current = decodedBuffer;
                    internalBlobRef.current = audioBlob;
                    console.log('Audio buffer decoded:', decodedBuffer.duration, 'seconds');

                    // Initialize with single segment covering whole audio
                    setSegments([{
                        id: generateId(),
                        originalStart: 0,
                        originalEnd: decodedBuffer.duration,
                        name: null,
                    }]);
                    setSelectedSegmentIndex(null);
                } catch (err) {
                    console.error('Failed to decode audio:', err);
                }
            };
            decodeAudio();

            return () => URL.revokeObjectURL(url);
        }
    }, [audioBlob, getAudioContext]);

    // Enumerate audio input devices
    const refreshDevices = useCallback(async () => {
        try {
            // Request permission first (needed to get device labels)
            await navigator.mediaDevices.getUserMedia({ audio: true })
                .then(stream => stream.getTracks().forEach(t => t.stop()));

            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioInputs = devices.filter(d => d.kind === 'audioinput');
            console.log('Available audio devices:', audioInputs.map(d => ({ id: d.deviceId, label: d.label })));
            setAudioDevices(audioInputs);

            // Select first non-default device if available, or keep current selection
            if (!selectedDeviceId && audioInputs.length > 0) {
                const nonDefault = audioInputs.find(d => !d.label.toLowerCase().includes('default'));
                setSelectedDeviceId(nonDefault?.deviceId || audioInputs[0].deviceId);
            }
        } catch (err) {
            console.error('Failed to enumerate devices:', err);
        }
    }, [selectedDeviceId]);

    useEffect(() => {
        refreshDevices();
        // Listen for device changes
        navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
        return () => navigator.mediaDevices.removeEventListener('devicechange', refreshDevices);
    }, [refreshDevices]);

    const [isPreparing, setIsPreparing] = useState(false);
    const [recordingElapsed, setRecordingElapsed] = useState(0);
    const recordingTimerRef = useRef(null);

    const startRecording = useCallback(async () => {
        try {
            // Request audio from selected device
            // Enable autoGainControl to boost quiet microphones
            const audioConstraints = {
                echoCancellation: false,
                noiseSuppression: true,
                autoGainControl: true,
            };
            if (selectedDeviceId) {
                audioConstraints.deviceId = { exact: selectedDeviceId };
            }
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: audioConstraints
            });

            // Debug: Check if audio track is active and its settings
            const audioTrack = stream.getAudioTracks()[0];
            const settings = audioTrack?.getSettings();
            console.log('Audio track:', audioTrack?.label, 'enabled:', audioTrack?.enabled, 'muted:', audioTrack?.muted);
            console.log('Track settings:', settings);

            // Let browser choose best codec
            const mediaRecorder = new MediaRecorder(stream);
            mediaRecorderRef.current = mediaRecorder;
            chunksRef.current = [];

            mediaRecorder.ondataavailable = (e) => {
                console.log('Data available:', e.data.size, 'bytes');
                if (e.data.size > 0) {
                    chunksRef.current.push(e.data);
                }
            };

            mediaRecorder.onstop = async () => {
                // ... (onstop logic remains same) ...
                const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
                internalBlobRef.current = blob;
                console.log('Recording stopped. Blob created:', blob.size, blob.type, 'chunks:', chunksRef.current.length);

                // Stop tracks before loading to wavesurfer
                stream.getTracks().forEach(track => track.stop());

                const url = URL.createObjectURL(blob);
                try {
                    await wavesurferRef.current.load(url);

                    // Decode and store audio buffer for editing
                    const arrayBuffer = await blob.arrayBuffer();
                    const audioCtx = await getAudioContext();
                    const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);
                    originalAudioBufferRef.current = decodedBuffer;
                    currentAudioBufferRef.current = decodedBuffer;

                    // Initialize segments for new recording
                    setSegments([{
                        id: generateId(),
                        originalStart: 0,
                        originalEnd: decodedBuffer.duration,
                        name: null,
                    }]);
                    setSelectedSegmentIndex(null);
                } catch (err) {
                    console.error('Wavesurfer load error:', err);
                }

                if (onRecordingComplete) {
                    onRecordingComplete(blob);
                }
            };

            // Start with timeslice to get data chunks periodically (every 100ms)
            mediaRecorder.start(100);

            // WARMUP: Set preparing state
            setIsPreparing(true);

            // Wait 1.5s then show "Recording" state
            setTimeout(() => {
                setIsPreparing(false);
                setIsRecording(true);
            }, 1500);

        } catch (err) {
            console.error('Failed to start recording:', err);
            toast.error('Failed to access microphone: ' + err.message);
            setIsPreparing(false);
        }
    }, [getAudioContext, onRecordingComplete, selectedDeviceId]);

    const stopRecording = useCallback(() => {
        if (mediaRecorderRef.current && isRecording) {
            mediaRecorderRef.current.stop();
            setIsRecording(false);
        }
    }, [isRecording]);

    // Recording elapsed timer
    useEffect(() => {
        if (isRecording) {
            setRecordingElapsed(0);
            recordingTimerRef.current = setInterval(() => {
                setRecordingElapsed(s => s + 1);
            }, 1000);
        } else {
            clearInterval(recordingTimerRef.current);
        }
        return () => clearInterval(recordingTimerRef.current);
    }, [isRecording]);

    const togglePlayPause = () => {
        if (wavesurferRef.current) {
            wavesurferRef.current.playPause();
        }
    };

    // Split audio at cursor position - creates two segments from one
    const handleSplit = useCallback(async () => {
        if (!hasAudio || segments.length === 0 || isProcessing) return;

        const splitTime = cursorPosition;

        // Find which segment contains the cursor (in current edited timeline)
        let accumulatedTime = 0;
        let segmentIndex = -1;
        let timeWithinSegment = 0;

        for (let i = 0; i < segments.length; i++) {
            const segDuration = segments[i].originalEnd - segments[i].originalStart;
            if (accumulatedTime + segDuration > splitTime) {
                segmentIndex = i;
                timeWithinSegment = splitTime - accumulatedTime;
                break;
            }
            accumulatedTime += segDuration;
        }

        if (segmentIndex === -1) {
            toast.info('Click on the waveform to set a split point');
            return;
        }

        const segment = segments[segmentIndex];
        const splitOriginalTime = segment.originalStart + timeWithinSegment;

        // Don't split if too close to edges (0.2 seconds minimum)
        if (splitOriginalTime - segment.originalStart < 0.2 ||
            segment.originalEnd - splitOriginalTime < 0.2) {
            toast.info('Split point too close to edge');
            return;
        }

        // Create two new segments from the split
        const newSegments = [...segments];
        const firstHalf = {
            id: generateId(),
            originalStart: segment.originalStart,
            originalEnd: splitOriginalTime,
            name: segment.name ? `${segment.name} (1)` : null,
        };
        const secondHalf = {
            id: generateId(),
            originalStart: splitOriginalTime,
            originalEnd: segment.originalEnd,
            name: segment.name ? `${segment.name} (2)` : null,
        };

        newSegments.splice(segmentIndex, 1, firstHalf, secondHalf);
        setSegments(newSegments);
        setSelectedSegmentIndex(null);

        // Update region markers to show the split
        updateSplitMarkers(newSegments, duration);
        toast.success('Split created');
    }, [hasAudio, segments, cursorPosition, isProcessing, duration, updateSplitMarkers]);

    // Delete selected segment and regenerate waveform
    const handleDeleteSegment = useCallback(async () => {
        if (selectedSegmentIndex === null || segments.length <= 1 || isProcessing) {
            if (segments.length <= 1) {
                toast.info('Cannot delete the only segment');
            }
            return;
        }

        const newSegments = segments.filter((_, i) => i !== selectedSegmentIndex);
        setSegments(newSegments);
        setSelectedSegmentIndex(null);

        // Regenerate waveform without the deleted segment
        await regenerateWaveform(newSegments);
        toast.success('Segment deleted');
    }, [selectedSegmentIndex, segments, isProcessing, regenerateWaveform]);

    // Toggle instruction tag on the selected segment
    const handleToggleInstruction = useCallback(() => {
        if (selectedSegmentIndex === null) return;
        setSegments(prev => {
            const updated = prev.map((seg, i) =>
                i === selectedSegmentIndex ? { ...seg, isInstruction: !seg.isInstruction } : seg
            );
            updateSplitMarkers(updated);
            return updated;
        });
    }, [selectedSegmentIndex, updateSplitMarkers]);

    // Move segment to new position and regenerate waveform
    const handleMoveSegment = useCallback(async (fromIndex, toIndex) => {
        if (fromIndex === toIndex || isProcessing) return;

        const newSegments = [...segments];
        const [movedSegment] = newSegments.splice(fromIndex, 1);
        newSegments.splice(toIndex, 0, movedSegment);
        setSegments(newSegments);
        setSelectedSegmentIndex(toIndex);

        // Regenerate waveform with new segment order
        await regenerateWaveform(newSegments);
        toast.success('Segment moved');
    }, [segments, isProcessing, regenerateWaveform]);

    // Insert audio from blob at a specific position in the segments array
    const handleInsertAudio = useCallback(async (audioBlob, insertIndex) => {
        if (isProcessing) return;

        setIsProcessing(true);
        try {
            // Decode the new audio
            const arrayBuffer = await audioBlob.arrayBuffer();
            const audioCtx = await getAudioContext();
            const newBuffer = await audioCtx.decodeAudioData(arrayBuffer);

            if (!originalAudioBufferRef.current) {
                // First audio — initialize the editor with this buffer
                originalAudioBufferRef.current = newBuffer;
                currentAudioBufferRef.current = newBuffer;

                const blob = audioBufferToWavBlob(newBuffer);
                internalBlobRef.current = blob;

                const newSegments = [{
                    id: generateId(),
                    originalStart: 0,
                    originalEnd: newBuffer.duration,
                    name: 'Inserted',
                }];
                setSegments(newSegments);
                setSelectedSegmentIndex(0);
                setDuration(newBuffer.duration);

                // Load into wavesurfer
                const url = URL.createObjectURL(blob);
                await wavesurferRef.current.load(url);
                URL.revokeObjectURL(url);
            } else {
                // Append to existing audio
                const { appendedStartTime, appendedEndTime } = await appendToOriginalBuffer(newBuffer);

                const newSegment = {
                    id: generateId(),
                    originalStart: appendedStartTime,
                    originalEnd: appendedEndTime,
                    name: 'Inserted',
                };

                const newSegments = [...segments];
                newSegments.splice(insertIndex, 0, newSegment);
                setSegments(newSegments);
                setSelectedSegmentIndex(insertIndex);

                // Regenerate waveform
                await regenerateWaveform(newSegments);
            }
            toast.success('Audio inserted');
        } catch (err) {
            console.error('Failed to insert audio:', err);
            toast.error('Failed to insert audio: ' + err.message);
        }
        setIsProcessing(false);
    }, [getAudioContext, isProcessing, segments, appendToOriginalBuffer, regenerateWaveform]);

    // Drag handlers for segment reordering
    const handleDragStart = (e, index) => {
        setDraggedSegmentIndex(index);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', index.toString());
    };



    const handleDragLeave = (e) => {
        // Only clear if leaving the segment blocks container entirely
        if (!e.currentTarget.contains(e.relatedTarget)) {
            setDragOverIndex(null);
        }
    };

    // Handle drop on drop zone (between segments)
    const handleDropZoneDrop = (e, insertIndex) => {
        e.preventDefault();
        e.stopPropagation();
        if (draggedSegmentIndex !== null) {
            // Adjust index if dragging from before the drop zone
            const adjustedIndex = draggedSegmentIndex < insertIndex ? insertIndex - 1 : insertIndex;
            if (draggedSegmentIndex !== adjustedIndex) {
                handleMoveSegment(draggedSegmentIndex, adjustedIndex);
            }
        }
        setDraggedSegmentIndex(null);
        setDragOverIndex(null);
    };

    const handleDropZoneDragOver = (e, index) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDragOverIndex(`zone-${index}`);
    };



    const handleDragEnd = () => {
        setDraggedSegmentIndex(null);
        setDragOverIndex(null);
    };

    // Segment naming handlers
    const startEditingSegmentName = (index, e) => {
        e.stopPropagation();
        setEditingSegmentName(index);
        setEditingNameValue(segments[index].name || '');
    };

    const saveSegmentName = useCallback(() => {
        if (editingSegmentName !== null) {
            const newSegments = [...segments];
            newSegments[editingSegmentName] = {
                ...newSegments[editingSegmentName],
                name: editingNameValue.trim() || null
            };
            setSegments(newSegments);
            setEditingSegmentName(null);
            setEditingNameValue('');
        }
    }, [editingSegmentName, editingNameValue, segments]);

    const cancelEditingSegmentName = () => {
        setEditingSegmentName(null);
        setEditingNameValue('');
    };

    const handleSegmentNameKeyDown = (e) => {
        if (e.key === 'Enter') {
            saveSegmentName();
        } else if (e.key === 'Escape') {
            cancelEditingSegmentName();
        }
    };

    // Calculate total edited duration
    const getEditedDuration = useCallback(() => {
        return segments.reduce((total, seg) => total + (seg.originalEnd - seg.originalStart), 0);
    }, [segments]);

    // Update region markers when selection changes
    useEffect(() => {
        if (hasAudio && segments.length > 1) {
            updateSplitMarkers(segments, duration);
        }
    }, [selectedSegmentIndex, hasAudio, segments, duration, updateSplitMarkers]);

    const formatTime = (seconds) => {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    // Format time with milliseconds for precision display
    const formatTimeMs = (seconds) => {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 1000);
        return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
    };

    const handleImport = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'audio/*';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (file && wavesurferRef.current) {
                try {
                    // Decode and store the imported audio
                    const arrayBuffer = await file.arrayBuffer();
                    const audioCtx = await getAudioContext();
                    const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
                    originalAudioBufferRef.current = decodedBuffer;
                    currentAudioBufferRef.current = decodedBuffer;

                    // Create blob from the already-read buffer (avoid reading file twice)
                    const blob = new Blob([arrayBuffer], { type: file.type });
                    internalBlobRef.current = blob;

                    const url = URL.createObjectURL(file);
                    await wavesurferRef.current.load(url);
                    URL.revokeObjectURL(url);

                    // Initialize segments for imported audio
                    setSegments([{
                        id: generateId(),
                        originalStart: 0,
                        originalEnd: decodedBuffer.duration,
                        name: null,
                    }]);
                    setSelectedSegmentIndex(null);
                    setCursorPosition(0);

                    // Clear any existing regions
                    if (regionsRef.current) {
                        regionsRef.current.clearRegions();
                    }
                } catch (err) {
                    console.error('Failed to import audio:', err);
                    toast.error('Failed to import audio file');
                }
            }
        };
        input.click();
    };

    // Save project to file (JSON with base64 audio)
    const handleSaveProject = useCallback(async () => {
        if (!hasAudio || isProcessing) return;

        setIsProcessing(true);
        try {
            // Serialize the full original buffer (includes any appended/inserted audio)
            const originalBuffer = originalAudioBufferRef.current;
            const originalBlob = originalBuffer ? audioBufferToWavBlob(originalBuffer) : (internalBlobRef.current || audioBlob);
            if (!originalBlob) {
                toast.error('No audio to save');
                setIsProcessing(false);
                return;
            }

            const arrayBuffer = await originalBlob.arrayBuffer();
            const base64Audio = btoa(
                new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
            );

            const project = {
                version: 2,
                name: projectName || `Project_${Date.now()}`,
                createdAt: new Date().toISOString(),
                audioType: originalBlob.type,
                audioBase64: base64Audio,
                segments: segments,
                zoomLevel: zoomLevel,
                duration: duration,
            };

            // Download as JSON file
            const projectJson = JSON.stringify(project, null, 2);
            const blob = new Blob([projectJson], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${project.name.replace(/[^a-zA-Z0-9]/g, '_')}.audioproject.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            toast.success('Project saved');
        } catch (err) {
            console.error('Save project failed:', err);
            toast.error('Failed to save project');
        }
        setIsProcessing(false);
    }, [hasAudio, audioBlob, segments, zoomLevel, duration, projectName, isProcessing]);

    // Load project from file
    const handleLoadProject = useCallback(() => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,.audioproject.json';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            setIsProcessing(true);
            try {
                const text = await file.text();
                const project = JSON.parse(text);

                if (!project.audioBase64 || !project.segments) {
                    toast.error('Invalid project file');
                    setIsProcessing(false);
                    return;
                }

                // Convert base64 back to blob
                const binaryString = atob(project.audioBase64);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }
                const audioBlob = new Blob([bytes], { type: project.audioType || 'audio/wav' });

                // Decode audio buffer
                const arrayBuffer = await audioBlob.arrayBuffer();
                const audioCtx = await getAudioContext();
                const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);
                originalAudioBufferRef.current = decodedBuffer;
                currentAudioBufferRef.current = decodedBuffer;
                internalBlobRef.current = audioBlob;

                // Load into waveform
                const url = URL.createObjectURL(audioBlob);
                await wavesurferRef.current.load(url);
                URL.revokeObjectURL(url);

                // Restore project state
                setSegments(project.segments);
                setProjectName(project.name || '');
                if (project.zoomLevel) {
                    applyZoom(project.zoomLevel);
                }
                setSelectedSegmentIndex(null);
                setCursorPosition(0);

                // Regenerate waveform with segments
                if (project.segments.length > 0) {
                    await regenerateWaveform(project.segments);
                }

                toast.success('Project loaded');
            } catch (err) {
                console.error('Load project failed:', err);
                toast.error('Failed to load project: ' + err.message);
            }
            setIsProcessing(false);
        };
        input.click();
    }, [applyZoom, getAudioContext, regenerateWaveform]);

    // Export the edited audio (with all segment edits applied)
    const handleExport = useCallback(async () => {
        if (!hasAudio || isProcessing) return;

        setIsProcessing(true);
        try {
            // Use the current internal blob (already reflects edits)
            const exportBlob = internalBlobRef.current || audioBlob;

            if (!exportBlob) {
                toast.error('No audio to export');
                setIsProcessing(false);
                return;
            }

            // Create download link
            const url = URL.createObjectURL(exportBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `recording_${Date.now()}.wav`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            toast.success('Audio exported');
        } catch (err) {
            console.error('Export failed:', err);
            toast.error('Failed to export audio');
        }
        setIsProcessing(false);
    }, [hasAudio, audioBlob, isProcessing]);

    return (
        <div className="audio-editor">
            <div className="device-selector-row">
                <label htmlFor="mic-select">Microphone:</label>
                <select
                    id="mic-select"
                    value={selectedDeviceId}
                    onChange={(e) => setSelectedDeviceId(e.target.value)}
                    disabled={isRecording}
                    className="mic-select"
                >
                    {audioDevices.map(device => (
                        <option key={device.deviceId} value={device.deviceId}>
                            {device.label || `Microphone ${device.deviceId.slice(0, 8)}`}
                        </option>
                    ))}
                </select>
                <button
                    className="refresh-btn"
                    onClick={refreshDevices}
                    disabled={isRecording}
                    title="Refresh device list"
                >
                    🔄
                </button>
            </div>

            <div className="editor-controls-row">
                {!isRecording && !isPreparing ? (
                    <button className="editor-record-btn" onClick={startRecording}>
                        <div className="record-dot"></div>
                        Record
                    </button>
                ) : (
                    <button className={`editor-record-btn ${isPreparing ? 'preparing' : 'recording'}`} onClick={stopRecording}>
                        <div className="record-dot"></div>
                        {isPreparing ? 'Preparing...' : 'Stop Recording'}
                    </button>
                )}
                <button
                    className="editor-play-btn"
                    onClick={togglePlayPause}
                    disabled={!hasAudio}
                >
                    {isPlaying ? '⏸️' : '▶️'}
                </button>

                <div className="time-display">
                    {isRecording || isPreparing ? (
                        <span className="recording-time">{formatTime(recordingElapsed)}</span>
                    ) : (
                        <>
                            <span className="current-time">{zoomLevel >= 500 ? formatTimeMs(currentTime) : formatTime(currentTime)}</span>
                            <span className="separator">/</span>
                            <span className="total-time">{zoomLevel >= 500 ? formatTimeMs(duration) : formatTime(duration)}</span>
                        </>
                    )}
                </div>
            </div>

            <div className={`waveform-container ${isProcessing ? 'processing' : ''}`} ref={containerRef}>
                {!hasAudio && !isRecording && (
                    <div className="waveform-empty">
                        Click "Record" or "Import" to add audio
                    </div>
                )}
                {isProcessing && (
                    <div className="waveform-processing">
                        <span className="processing-spinner"></span>
                        Updating...
                    </div>
                )}
            </div>

            {/* Zoom Controls */}
            {hasAudio && (
                <div className="zoom-controls">
                    <span className="zoom-label">Zoom:</span>
                    <button
                        className="zoom-btn"
                        onClick={handleZoomOut}
                        disabled={zoomLevel <= ZOOM_PRESETS[0].value || isProcessing}
                        title="Zoom out"
                    >
                        −
                    </button>
                    <div className="zoom-presets">
                        {ZOOM_PRESETS.map((preset) => (
                            <button
                                key={preset.value}
                                className={`zoom-preset-btn ${zoomLevel === preset.value ? 'active' : ''}`}
                                onClick={() => applyZoom(preset.value)}
                                disabled={isProcessing}
                                title={preset.description}
                            >
                                {preset.label}
                            </button>
                        ))}
                    </div>
                    <button
                        className="zoom-btn"
                        onClick={handleZoomIn}
                        disabled={zoomLevel >= ZOOM_PRESETS[ZOOM_PRESETS.length - 1].value || isProcessing}
                        title="Zoom in"
                    >
                        +
                    </button>
                    <span className="zoom-info">
                        {getCurrentZoomLabel()} view
                    </span>
                </div>
            )}

            {/* Segment Timeline - only show when there are multiple segments */}
            {hasAudio && segments.length > 1 && (
                <div className="segment-timeline">
                    <div className="segment-timeline-label">
                        <span>Segments ({segments.length})</span>
                        <span className="edited-duration">
                            Duration: {formatTime(getEditedDuration())}
                        </span>
                    </div>
                    <div className="segment-blocks" onDragLeave={handleDragLeave}>
                        {/* Drop zone before first segment */}
                        <div
                            className={`drop-zone ${dragOverIndex === 'zone-0' ? 'active' : ''} ${draggedSegmentIndex !== null ? 'visible' : ''}`}
                            onDragOver={(e) => handleDropZoneDragOver(e, 0)}
                            onDrop={(e) => handleDropZoneDrop(e, 0)}
                        >
                            <div className="drop-indicator">
                                <span className="drop-arrow">▼</span>
                            </div>
                        </div>
                        {segments.map((segment, index) => {
                            const segDuration = segment.originalEnd - segment.originalStart;
                            const totalDur = getEditedDuration();
                            const percentage = totalDur > 0 ? (segDuration / totalDur) * 100 : 100 / segments.length;
                            const isSelected = selectedSegmentIndex === index;
                            const isDragging = draggedSegmentIndex === index;
                            const isProcessingActive = (processingState?.phase === 'transcribing' || processingState?.phase === 'processing') && processingState?.activeSegmentIndex === index;
                            const isProcessingDim = (processingState?.phase === 'transcribing' || processingState?.phase === 'processing') && !segment.isInstruction;

                            return (
                                <React.Fragment key={segment.id}>
                                    <div
                                        className={`segment-block ${isSelected ? 'selected' : ''} ${isDragging ? 'dragging' : ''} ${segment.isInstruction ? 'instruction' : ''} ${isProcessingActive ? 'processing-active' : ''} ${isProcessingDim ? 'processing-dim' : ''}`}
                                        title={segment.isInstruction ? 'Instruction segment' : undefined}
                                        style={{ flex: `${percentage} 0 0` }}
                                        onClick={() => setSelectedSegmentIndex(isSelected ? null : index)}
                                        draggable={!isProcessing && editingSegmentName !== index}
                                        onDragStart={(e) => handleDragStart(e, index)}
                                        onDragEnd={handleDragEnd}
                                    >
                                        {segment.isInstruction && (
                                            <span className="instruction-badge" aria-label="Instruction segment">⚑</span>
                                        )}
                                        {editingSegmentName === index ? (
                                            <input
                                                type="text"
                                                className="segment-name-input"
                                                value={editingNameValue}
                                                onChange={(e) => setEditingNameValue(e.target.value)}
                                                onKeyDown={handleSegmentNameKeyDown}
                                                onBlur={saveSegmentName}
                                                onClick={(e) => e.stopPropagation()}
                                                autoFocus
                                                placeholder={`Segment ${index + 1}`}
                                            />
                                        ) : (
                                            <span
                                                className="segment-index clickable"
                                                onClick={(e) => startEditingSegmentName(index, e)}
                                                title="Click to rename segment"
                                            >
                                                {segment.name || index + 1}
                                            </span>
                                        )}
                                        <span className="segment-duration">{zoomLevel >= 500 ? formatTimeMs(segDuration) : formatTime(segDuration)}</span>
                                        {isSelected && segments.length > 1 && (
                                            <button
                                                className="segment-delete-btn"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleDeleteSegment();
                                                }}
                                                title="Delete this segment"
                                                disabled={isProcessing}
                                            >
                                                ×
                                            </button>
                                        )}
                                    </div>
                                    {/* Drop zone after each segment */}
                                    <div
                                        className={`drop-zone ${dragOverIndex === `zone-${index + 1}` ? 'active' : ''} ${draggedSegmentIndex !== null ? 'visible' : ''}`}
                                        onDragOver={(e) => handleDropZoneDragOver(e, index + 1)}
                                        onDrop={(e) => handleDropZoneDrop(e, index + 1)}
                                    >
                                        <div className="drop-indicator">
                                            <span className="drop-arrow">▼</span>
                                        </div>
                                    </div>
                                </React.Fragment>
                            );
                        })}
                    </div>
                    <div className="segment-instructions">
                        Click waveform to set split point • Click number to rename • Drag to reorder • Click × to delete
                    </div>
                </div>
            )}

            <div className="editor-toolbar">
                <button
                    className="tool-btn"
                    onClick={handleSplit}
                    disabled={!hasAudio || isProcessing}
                    title="Split audio at cursor position"
                >
                    ✂️ Split
                </button>
                <button
                    className="tool-btn"
                    onClick={() => setIsInsertModalOpen(true)}
                    disabled={isRecording || isProcessing}
                    title="Insert audio from file or recording"
                >
                    ➕ Insert Audio
                </button>
                <button
                    className="tool-btn danger"
                    onClick={handleDeleteSegment}
                    disabled={selectedSegmentIndex === null || segments.length <= 1 || isProcessing}
                    title="Delete selected segment"
                >
                    🗑️ Delete Segment
                </button>
                <button
                    className={`tool-btn${segments[selectedSegmentIndex]?.isInstruction ? ' instruction active' : ' instruction'}`}
                    onClick={handleToggleInstruction}
                    disabled={selectedSegmentIndex === null || isProcessing}
                    title={selectedSegmentIndex !== null && segments[selectedSegmentIndex]?.isInstruction
                        ? 'Remove instruction tag from this segment'
                        : 'Tag this segment as an instruction'}
                >
                    {selectedSegmentIndex !== null && segments[selectedSegmentIndex]?.isInstruction
                        ? '⚑ Instruction (on)'
                        : '⚐ Tag as Instruction'}
                </button>
                <div className="toolbar-divider"></div>
                <button className="tool-btn" onClick={handleImport} disabled={isProcessing} title="Import audio file">
                    📥 Import
                </button>
                <button className="tool-btn" onClick={handleExport} disabled={!hasAudio || isProcessing} title="Export edited audio">
                    📤 Export
                </button>
                <div className="toolbar-divider"></div>
                <button className="tool-btn project" onClick={handleSaveProject} disabled={!hasAudio || isProcessing} title="Save project with segments for later editing">
                    💾 Save Project
                </button>
                <button className="tool-btn project" onClick={handleLoadProject} disabled={isProcessing} title="Load a saved project">
                    📂 Load Project
                </button>
                <div className="toolbar-divider"></div>
                <button className="tool-btn danger" onClick={clearAll} disabled={isProcessing}>
                    🗑️ Clear All
                </button>
                <button className="tool-btn primary" onClick={onTranscribe} disabled={!hasAudio || isProcessing || isTranscribing}>
                    {isTranscribing ? '⏳ Transcribing...' : '🎯 Transcribe'}
                </button>
                <button
                    className="tool-btn primary"
                    onClick={onProcess}
                    disabled={!hasAudio || isProcessing || isTranscribing || isProcessingLlm || !segments.some(s => s.isInstruction)}
                    title="Transcribe and process instruction-tagged segments through the LLM pipeline"
                >
                    {processingState?.phase === 'transcribing' ? '⏳ Transcribing...' : isProcessingLlm ? '⏳ Processing...' : '⚡ Process'}
                </button>
                {(processingState?.phase === 'transcribing' || processingState?.phase === 'processing') && (
                    <>
                        <button className="tool-btn danger" onClick={onCancelProcess} title="Cancel processing">
                            Cancel
                        </button>
                        {processingState?.stepProgress && (
                            <span className="processing-progress">
                                Processing {processingState.stepProgress.current}/{processingState.stepProgress.total}...
                            </span>
                        )}
                    </>
                )}
                {processingState?.phase === 'error' && (
                    <>
                        <span className="processing-error">{processingState.error}</span>
                        <button className="tool-btn" onClick={onRetryProcess} title="Retry processing">
                            Retry
                        </button>
                    </>
                )}
            </div>

            <InsertAudioModal
                isOpen={isInsertModalOpen}
                onClose={() => setIsInsertModalOpen(false)}
                onInsert={(audioBlob, insertIndex) => {
                    setIsInsertModalOpen(false);
                    handleInsertAudio(audioBlob, insertIndex);
                }}
                segments={segments}
                selectedSegmentIndex={selectedSegmentIndex}
                audioDevices={audioDevices}
                selectedDeviceId={selectedDeviceId}
                onDeviceChange={setSelectedDeviceId}
            />
        </div>
    );
});

AudioEditor.displayName = 'AudioEditor';

export default AudioEditor;
