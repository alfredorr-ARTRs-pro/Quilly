const test = require('node:test');
const assert = require('node:assert');
const { ASSETS } = require('./sherpaDownloader.cjs');

test('every asset pins a sha256 and a GitHub release URL', () => {
    const names = Object.keys(ASSETS);
    assert.deepStrictEqual(names.sort(), ['binary', 'embedding', 'segmentation']);
    for (const [name, asset] of Object.entries(ASSETS)) {
        assert.match(asset.sha256, /^[a-f0-9]{64}$/, `${name} sha256`);
        assert.match(
            asset.url,
            /^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\//,
            `${name} url`
        );
    }
});

test('binary and embedding assets pin exact sizes', () => {
    assert.strictEqual(ASSETS.binary.size, 18_746_895);
    assert.strictEqual(ASSETS.embedding.size, 40_257_283);
});

test('archives are tar.bz2 (the platform layer extracts them natively)', () => {
    assert.match(ASSETS.binary.archiveName, /\.tar\.bz2$/);
    assert.match(ASSETS.segmentation.archiveName, /\.tar\.bz2$/);
    assert.match(ASSETS.embedding.fileName, /\.onnx$/);
});
