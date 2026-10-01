'use strict';

// Tests for electron/whisperCppService.cjs — duration-aware timeout scaling.
// Run: node --test electron/whisperCppService.test.cjs
//
// Background: whisper.cpp runs as a subprocess with a kill timer. A fixed 120s
// ceiling starves long files — a 70-min recording cannot finish in 120s, so it
// always times out and falls back to the slow CPU path, defeating the GPU
// exactly when it matters most. computeWhisperTimeout() scales the budget with
// audio length instead. These tests pin that behaviour.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');

// ─── Mock electron before requiring the service ───────────────────────────────
// whisperCppService requires electron's `app` (app.getPath) at module load.
const Module = require('module');
const _originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
        return { app: { getPath: () => os.tmpdir() } };
    }
    return _originalLoad.apply(this, arguments);
};

const { computeWhisperTimeout } = require('./whisperCppService.cjs');

describe('computeWhisperTimeout', () => {
    test('short clips get the 120s floor, not less', () => {
        assert.equal(computeWhisperTimeout(10), 120);
        assert.equal(computeWhisperTimeout(0.5), 120);
    });

    test('floor applies up to the break-even point (60s of audio)', () => {
        // 60s * 2 = 120s, equal to the floor
        assert.equal(computeWhisperTimeout(60), 120);
    });

    test('long files scale past the floor (the 71-min m4a case)', () => {
        // 4271.9s of audio → ceil(4271.9 * 2) = 8544s, far above 120s
        assert.equal(computeWhisperTimeout(4271.9), 8544);
        // A 70-min file must get well more than the old fixed 120s
        assert.ok(computeWhisperTimeout(70 * 60) > 120);
    });

    test('an explicit positive options.timeout always wins', () => {
        assert.equal(computeWhisperTimeout(4271.9, { timeout: 300 }), 300);
        assert.equal(computeWhisperTimeout(10, { timeout: 600 }), 600);
    });

    test('non-positive or invalid options.timeout is ignored, scaling applies', () => {
        assert.equal(computeWhisperTimeout(4271.9, { timeout: 0 }), 8544);
        assert.equal(computeWhisperTimeout(4271.9, { timeout: -5 }), 8544);
        assert.equal(computeWhisperTimeout(4271.9, { timeout: NaN }), 8544);
    });

    test('invalid/zero/negative duration falls back to the floor', () => {
        assert.equal(computeWhisperTimeout(0), 120);
        assert.equal(computeWhisperTimeout(-100), 120);
        assert.equal(computeWhisperTimeout(NaN), 120);
        assert.equal(computeWhisperTimeout(undefined), 120);
    });
});
