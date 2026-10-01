/**
 * Shared audio processing utilities for transcription.
 * Handles resampling to 16kHz mono and gain boosting for Whisper.
 */

import { concatFloat32, sliceRanges } from './resampleBuffer.js';

// Resample long recordings in bounded slices. A single OfflineAudioContext
// spanning the whole duration throws / OOMs on long audio (a 10-minute
// recording used to fail silently), so process ~2-minute source windows and
// concatenate the 16kHz output.
const RESAMPLE_SLICE_SECS = 120;
const TARGET_RATE = 16000;

/**
 * Process an audio blob for transcription: decode, resample to 16kHz mono,
 * boost quiet audio, and return as a Float32Array for IPC serialization.
 *
 * @param {Blob} audioBlob - The audio blob to process
 * @returns {Promise<{audioArray: Float32Array, durationStr: string}>}
 */
export async function processAudioForTranscription(audioBlob) {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    try {
        const arrayBuffer = await audioBlob.arrayBuffer();
        const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));

        // Resample to 16kHz mono in bounded slices (see note above).
        const srcRate = decoded.sampleRate;
        const sliceSrcSamples = RESAMPLE_SLICE_SECS * srcRate;
        const ranges = sliceRanges(decoded.length, sliceSrcSamples);

        const outChunks = [];
        for (const [start, end] of ranges) {
            const sliceLen = end - start;
            const outLen = Math.max(1, Math.round((sliceLen / srcRate) * TARGET_RATE));
            const offlineCtx = new OfflineAudioContext(1, outLen, TARGET_RATE);
            const sliceBuf = offlineCtx.createBuffer(decoded.numberOfChannels, sliceLen, srcRate);
            for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
                sliceBuf.copyToChannel(decoded.getChannelData(ch).subarray(start, end), ch);
            }
            const source = offlineCtx.createBufferSource();
            source.buffer = sliceBuf;
            source.connect(offlineCtx.destination);
            source.start();
            const rendered = await offlineCtx.startRendering();
            outChunks.push(new Float32Array(rendered.getChannelData(0)));
        }
        const channelData = concatFloat32(outChunks);

        // Calculate duration string
        const durationSecs = channelData.length / 16000;
        const mins = Math.floor(durationSecs / 60);
        const secs = Math.floor(durationSecs % 60);
        const durationStr = `${mins}:${secs.toString().padStart(2, '0')}`;

        // Find peak amplitude
        let maxVal = 0;
        for (let i = 0; i < channelData.length; i++) {
            const absVal = Math.abs(channelData[i]);
            if (absVal > maxVal) maxVal = absVal;
        }

        // Boost quiet audio (peak < 0.1) up to 50x gain
        let processedData = channelData;
        if (maxVal > 0 && maxVal < 0.1) {
            const gainFactor = Math.min(0.5 / maxVal, 50);
            processedData = new Float32Array(channelData.length);
            for (let i = 0; i < channelData.length; i++) {
                processedData[i] = Math.max(-1, Math.min(1, channelData[i] * gainFactor));
            }
        }

        // Create an independent copy — processedData may be a view into the
        // AudioBuffer, which can be GC'd before IPC serialization finishes.
        // Use Float32Array (not Array.from) to halve memory: 4 bytes/sample vs ~8+ for boxed JS numbers.
        // All downstream consumers (whisperCppService, whisperService) already handle Float32Array natively.
        const audioArray = new Float32Array(processedData);

        return { audioArray, durationStr };
    } finally {
        audioContext.close();
    }
}
