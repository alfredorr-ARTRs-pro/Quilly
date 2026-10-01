const test = require('node:test');
const assert = require('node:assert');
const { mergeTranscriptWithTurns, defaultSpeakerNames, formatDiarizedTranscript } = require('./diarizationMerge.cjs');

const seg = (text, from, to) => ({ text, timestamp: [from, to] });

test('assigns each segment the speaker with maximum overlap', () => {
    const merged = mergeTranscriptWithTurns(
        [seg(' hello', 0, 4), seg(' world', 5, 9)],
        [{ start: 0, end: 4.5, speaker: 0 }, { start: 4.5, end: 9, speaker: 1 }]
    );
    assert.deepStrictEqual(merged, [
        { speaker: 0, start: 0, end: 4, text: 'hello' },
        { speaker: 1, start: 5, end: 9, text: 'world' },
    ]);
});

test('a turn boundary mid-segment goes to the dominant side', () => {
    // segment 2..8 overlaps speaker 0 by 1s (2..3) and speaker 1 by 5s (3..8)
    const merged = mergeTranscriptWithTurns(
        [seg('x', 2, 8)],
        [{ start: 0, end: 3, speaker: 0 }, { start: 3, end: 9, speaker: 1 }]
    );
    assert.strictEqual(merged[0].speaker, 1);
});

test('segment with no overlapping turn attaches to nearest turn by midpoint', () => {
    // segment midpoint 10.5: distance to turn A midpoint (1) is 9.5,
    // to turn B midpoint (16) is 5.5 → speaker 1
    const merged = mergeTranscriptWithTurns(
        [seg('gap', 10, 11)],
        [{ start: 0, end: 2, speaker: 0 }, { start: 12, end: 20, speaker: 1 }]
    );
    assert.strictEqual(merged[0].speaker, 1);
});

test('consecutive same-speaker segments merge into one block', () => {
    const merged = mergeTranscriptWithTurns(
        [seg(' a', 0, 1), seg(' b', 1, 2), seg(' c', 5, 6)],
        [{ start: 0, end: 2, speaker: 0 }, { start: 4, end: 7, speaker: 1 }]
    );
    assert.strictEqual(merged.length, 2);
    assert.deepStrictEqual(merged[0], { speaker: 0, start: 0, end: 2, text: 'a b' });
    assert.deepStrictEqual(merged[1], { speaker: 1, start: 5, end: 6, text: 'c' });
});

test('single speaker covers everything', () => {
    const merged = mergeTranscriptWithTurns(
        [seg('a', 0, 1), seg('b', 1, 2)],
        [{ start: 0, end: 2, speaker: 0 }]
    );
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].text, 'a b');
});

test('empty or invalid inputs return empty array', () => {
    assert.deepStrictEqual(mergeTranscriptWithTurns([], []), []);
    assert.deepStrictEqual(mergeTranscriptWithTurns(null, null), []);
    assert.deepStrictEqual(mergeTranscriptWithTurns(undefined, [{ start: 0, end: 1, speaker: 0 }]), []);
});

test('no turns at all → everything falls to speaker 0', () => {
    assert.deepStrictEqual(mergeTranscriptWithTurns([seg('a', 0, 1)], []), [
        { speaker: 0, start: 0, end: 1, text: 'a' },
    ]);
});

test('blank/whitespace segments are dropped', () => {
    const merged = mergeTranscriptWithTurns(
        [seg('  ', 0, 1), seg(' ok', 1, 2)],
        [{ start: 0, end: 2, speaker: 0 }]
    );
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].text, 'ok');
});

test('unsorted turns are handled (sorted internally)', () => {
    const merged = mergeTranscriptWithTurns(
        [seg('a', 0, 2), seg('b', 5, 7)],
        [{ start: 4, end: 8, speaker: 1 }, { start: 0, end: 3, speaker: 0 }]
    );
    assert.strictEqual(merged[0].speaker, 0);
    assert.strictEqual(merged[1].speaker, 1);
});

test('defaultSpeakerNames builds 1-based labels for distinct speakers', () => {
    assert.deepStrictEqual(
        defaultSpeakerNames([{ speaker: 2 }, { speaker: 0 }, { speaker: 2 }]),
        { '0': 'Speaker 1', '2': 'Speaker 2' }
    );
    assert.deepStrictEqual(defaultSpeakerNames([]), {});
    assert.deepStrictEqual(defaultSpeakerNames(null), {});
});

test('formatDiarizedTranscript uses names with fallback', () => {
    const out = formatDiarizedTranscript(
        [{ speaker: 0, text: 'hi' }, { speaker: 1, text: 'yo' }],
        { '0': 'Alfredo' }
    );
    assert.strictEqual(out, 'Alfredo: hi\n\nSpeaker 2: yo');
    assert.strictEqual(formatDiarizedTranscript([], {}), '');
    assert.strictEqual(formatDiarizedTranscript(null), '');
});
