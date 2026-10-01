// Pure helpers for combining a timestamped whisper transcript with speaker
// turns from sherpa-onnx offline speaker diarization. No Electron imports —
// exercised directly by node --test.

const overlap = (aStart, aEnd, bStart, bEnd) =>
    Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

/**
 * Assign each whisper segment to the speaker turn with maximum time overlap
 * (no-overlap segments attach to the nearest turn by midpoint distance),
 * then merge consecutive same-speaker segments into blocks.
 * @param {Array<{text: string, timestamp: [number, number]}>} whisperSegments seconds
 * @param {Array<{start: number, end: number, speaker: number}>} turns seconds
 * @returns {Array<{speaker: number, start: number, end: number, text: string}>}
 */
const mergeTranscriptWithTurns = (whisperSegments, turns) => {
    if (!Array.isArray(whisperSegments)) return [];
    const segments = whisperSegments
        .filter(s => s && typeof s.text === 'string' && s.text.trim() && Array.isArray(s.timestamp))
        .map(s => ({ text: s.text.trim(), start: s.timestamp[0], end: s.timestamp[1] }));
    if (segments.length === 0) return [];

    const sortedTurns = Array.isArray(turns) ? [...turns].sort((a, b) => a.start - b.start) : [];

    const assigned = segments.map(seg => {
        let speaker = null;
        let bestOverlap = 0;
        for (const t of sortedTurns) {
            const ov = overlap(seg.start, seg.end, t.start, t.end);
            if (ov > bestOverlap) { bestOverlap = ov; speaker = t.speaker; }
        }
        if (speaker === null && sortedTurns.length > 0) {
            const mid = (seg.start + seg.end) / 2;
            let bestDist = Infinity;
            for (const t of sortedTurns) {
                const d = Math.abs(mid - (t.start + t.end) / 2);
                if (d < bestDist) { bestDist = d; speaker = t.speaker; }
            }
        }
        return { speaker: speaker ?? 0, start: seg.start, end: seg.end, text: seg.text };
    });

    const merged = [];
    for (const seg of assigned) {
        const last = merged[merged.length - 1];
        if (last && last.speaker === seg.speaker) {
            last.end = seg.end;
            last.text = `${last.text} ${seg.text}`;
        } else {
            merged.push({ ...seg });
        }
    }
    return merged;
};

/** Distinct speakers (ascending) → { "<id>": "Speaker <n>" } with 1-based n. */
const defaultSpeakerNames = (segments) => {
    const ids = [...new Set((segments || []).map(s => s.speaker))].sort((a, b) => a - b);
    return Object.fromEntries(ids.map((id, i) => [String(id), `Speaker ${i + 1}`]));
};

/** "Name: text" blocks separated by blank lines; falls back to Speaker <id+1>. */
const formatDiarizedTranscript = (segments, speakerNames = {}) =>
    (segments || [])
        .map(s => `${speakerNames[String(s.speaker)] || `Speaker ${s.speaker + 1}`}: ${s.text}`)
        .join('\n\n');

module.exports = { mergeTranscriptWithTurns, defaultSpeakerNames, formatDiarizedTranscript };
