/**
 * Shared audio processing utilities for transcription.
 * Handles resampling to 16kHz mono and gain boosting for Whisper.
 */

/**
 * Process an audio blob for transcription: decode, resample to 16kHz mono,
 * boost quiet audio, and return as a regular Array for IPC serialization.
 *
 * @param {Blob} audioBlob - The audio blob to process
 * @returns {Promise<{audioArray: number[], durationStr: string}>}
 */
export async function processAudioForTranscription(audioBlob) {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    try {
        const arrayBuffer = await audioBlob.arrayBuffer();
        const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));

        // Resample to 16000Hz mono
        const offlineCtx = new OfflineAudioContext(1, decoded.duration * 16000, 16000);
        const source = offlineCtx.createBufferSource();
        source.buffer = decoded;
        source.connect(offlineCtx.destination);
        source.start();

        const resampled = await offlineCtx.startRendering();
        const channelData = resampled.getChannelData(0);

        // Calculate duration string
        const durationSecs = resampled.length / 16000;
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
