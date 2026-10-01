// Pure helpers for chunked audio resampling. Kept framework-free (no DOM / Web
// Audio) so they run under the Node test runner. Consumed by audioProcessing.js
// to resample long recordings in bounded slices instead of one giant
// OfflineAudioContext, which OOMs / throws on long audio.
//
// ESM on purpose: the Vite dev server serves source .cjs files without any
// CJS→ESM interop (no named exports, not even default), which white-screened
// the whole renderer in dev. `vite build` tolerated it, so releases were
// unaffected. Node tests reach this file via dynamic import().

/**
 * Concatenate an array of Float32Array chunks into a single Float32Array,
 * preserving order and values. Allocates the exact total length once.
 * @param {Float32Array[]} chunks
 * @returns {Float32Array}
 */
export function concatFloat32(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}

/**
 * Partition [0, totalSamples) into consecutive [start, end) ranges of at most
 * sliceSamples each. No gaps, no overlaps; the final range may be shorter.
 * @param {number} totalSamples
 * @param {number} sliceSamples
 * @returns {Array<[number, number]>}
 */
export function sliceRanges(totalSamples, sliceSamples) {
    const ranges = [];
    for (let start = 0; start < totalSamples; start += sliceSamples) {
        ranges.push([start, Math.min(start + sliceSamples, totalSamples)]);
    }
    return ranges;
}
