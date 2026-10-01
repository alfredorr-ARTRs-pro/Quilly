const { test } = require('node:test');
const assert = require('node:assert');
// resampleBuffer is ESM (the Vite dev server can't interop CJS source files),
// so this CJS test reaches it via dynamic import.
const helpers = import('./resampleBuffer.js');

test('concatFloat32 joins chunks in order, preserving values', async () => {
    const { concatFloat32 } = await helpers;
    const a = Float32Array.from([0.1, 0.2]);
    const b = Float32Array.from([0.3]);
    const out = concatFloat32([a, b]);
    assert.equal(out.length, 3);
    assert.ok(Math.abs(out[0] - 0.1) < 1e-6);
    assert.ok(Math.abs(out[2] - 0.3) < 1e-6);
    assert.ok(out instanceof Float32Array);
});

test('concatFloat32 handles empty input', async () => {
    const { concatFloat32 } = await helpers;
    assert.equal(concatFloat32([]).length, 0);
});

test('sliceRanges covers the whole range with no gaps or overlaps', async () => {
    const { sliceRanges } = await helpers;
    const ranges = sliceRanges(2500, 1000);
    assert.deepEqual(ranges, [[0, 1000], [1000, 2000], [2000, 2500]]);
});

test('sliceRanges with exact multiple has no trailing empty slice', async () => {
    const { sliceRanges } = await helpers;
    assert.deepEqual(sliceRanges(2000, 1000), [[0, 1000], [1000, 2000]]);
});

test('sliceRanges of zero length is empty', async () => {
    const { sliceRanges } = await helpers;
    assert.deepEqual(sliceRanges(0, 1000), []);
});
