const test = require('node:test');
const assert = require('node:assert');
const { parseDiarizationOutput, computeDiarizationTimeout } = require('./diarizationService.cjs');

test('parses turn lines and ignores config dump/Started/stats', () => {
    const stdout = [
        'OfflineSpeakerDiarizationConfig(segmentation=OfflineSpeakerSegmentationModelConfig(...), clustering=FastClusteringConfig(num_clusters=4, threshold=0.5))',
        'Started',
        '0.318 -- 6.865 speaker_00',
        '7.017 -- 10.747 speaker_01',
        '  11.455 -- 13.632  speaker_01 ',
        '',
    ].join('\r\n');
    assert.deepStrictEqual(parseDiarizationOutput(stdout), [
        { start: 0.318, end: 6.865, speaker: 0 },
        { start: 7.017, end: 10.747, speaker: 1 },
        { start: 11.455, end: 13.632, speaker: 1 },
    ]);
});

test('speaker indexes above 9 parse correctly', () => {
    assert.deepStrictEqual(parseDiarizationOutput('1.0 -- 2.0 speaker_12'), [
        { start: 1.0, end: 2.0, speaker: 12 },
    ]);
});

test('zero turns and junk input → empty array', () => {
    assert.deepStrictEqual(parseDiarizationOutput('Started\n'), []);
    assert.deepStrictEqual(parseDiarizationOutput(''), []);
    assert.deepStrictEqual(parseDiarizationOutput(null), []);
    assert.deepStrictEqual(parseDiarizationOutput('nonsense -- lines speaker_x'), []);
});

test('timeout floors at 120s and scales 60 + duration beyond', () => {
    assert.strictEqual(computeDiarizationTimeout(0), 120);
    assert.strictEqual(computeDiarizationTimeout(30), 120);
    assert.strictEqual(computeDiarizationTimeout(60), 120);
    assert.strictEqual(computeDiarizationTimeout(600), 660);
    assert.strictEqual(computeDiarizationTimeout(NaN), 120);
    assert.strictEqual(computeDiarizationTimeout(-5), 120);
});
