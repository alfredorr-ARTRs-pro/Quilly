'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createStreamingTextExtractor } = require('./streamingTextExtractor.cjs');

const pushAll = (extractor, chunks) => {
    let collected = '';
    for (const chunk of chunks) {
        collected += extractor.push(chunk);
    }
    return collected;
};

describe('streamingTextExtractor', () => {
    test('extracts text field from a single full JSON chunk', () => {
        const ex = createStreamingTextExtractor();
        const emitted = ex.push('{"text":"Hello world","editSummary":"no changes"}');
        assert.equal(emitted, 'Hello world');
        assert.equal(ex.finalize(), 'Hello world');
    });

    test('extracts text across many small chunks (one char at a time)', () => {
        const ex = createStreamingTextExtractor();
        const json = '{"text":"Hello world","editSummary":"x"}';
        const chunks = json.split('');
        const emitted = pushAll(ex, chunks);
        assert.equal(emitted, 'Hello world');
        assert.equal(ex.finalize(), 'Hello world');
    });

    test('decodes simple JSON string escapes', () => {
        const ex = createStreamingTextExtractor();
        const emitted = ex.push('{"text":"line one\\nline two\\t\\"quoted\\"","editSummary":"x"}');
        assert.equal(emitted, 'line one\nline two\t"quoted"');
    });

    test('decodes \\uXXXX escapes split across chunks', () => {
        const ex = createStreamingTextExtractor();
        // U+00E9 is 'é'
        const emitted = pushAll(ex, ['{"text":"caf\\', 'u00', 'E9","editSummary":"x"}']);
        assert.equal(emitted, 'café');
    });

    test('skips non-text fields appearing before text', () => {
        const ex = createStreamingTextExtractor();
        const emitted = ex.push('{"editSummary":"first","text":"the value"}');
        assert.equal(emitted, 'the value');
    });

    test('skips numeric and boolean values', () => {
        const ex = createStreamingTextExtractor();
        const emitted = ex.push('{"score":0.95,"valid":true,"text":"hi","editSummary":"x"}');
        assert.equal(emitted, 'hi');
    });

    test('falls back to plain text when stream does not start with {', () => {
        const ex = createStreamingTextExtractor();
        const emitted = pushAll(ex, ['Hello, ', 'world!']);
        assert.equal(emitted, 'Hello, world!');
        assert.equal(ex.isPlainText(), true);
        assert.equal(ex.finalize(), 'Hello, world!');
    });

    test('emits text incrementally as it arrives', () => {
        const ex = createStreamingTextExtractor();
        assert.equal(ex.push('{"text":"He'), 'He');
        assert.equal(ex.push('llo'), 'llo');
        assert.equal(ex.push(' world"'), ' world');
        assert.equal(ex.push(',"editSummary":"x"}'), '');
        assert.equal(ex.finalize(), 'Hello world');
    });

    test('handles partial output that never closes (truncated stream)', () => {
        const ex = createStreamingTextExtractor();
        const emitted = ex.push('{"text":"never closes');
        assert.equal(emitted, 'never closes');
        assert.equal(ex.finalize(), 'never closes');
    });

    test('handles whitespace and reordered keys', () => {
        const ex = createStreamingTextExtractor();
        const emitted = ex.push('{ "editSummary" : "x" , "text" : "value" }');
        assert.equal(emitted, 'value');
    });

    test('reset clears state', () => {
        const ex = createStreamingTextExtractor();
        ex.push('{"text":"first"}');
        assert.equal(ex.finalize(), 'first');
        ex.reset();
        ex.push('{"text":"second"}');
        assert.equal(ex.finalize(), 'second');
    });

    test('skips <think>...</think> prelude before JSON', () => {
        const ex = createStreamingTextExtractor();
        const emitted = ex.push('<think>I should clean up gently.</think>\n{"text":"Hi","editSummary":"x"}');
        assert.equal(emitted, 'Hi');
        assert.equal(ex.finalize(), 'Hi');
    });

    test('handles <think> prelude split across many chunks', () => {
        const ex = createStreamingTextExtractor();
        const json = '<think>thinking through the problem...</think>{"text":"ok","editSummary":"x"}';
        const chunks = json.match(/.{1,3}/g) || [json];
        let collected = '';
        for (const chunk of chunks) collected += ex.push(chunk);
        assert.equal(collected, 'ok');
    });

    test('non-think tag at start falls back to plain text', () => {
        const ex = createStreamingTextExtractor();
        // "<html>" is a valid prefix of "<" but not "<think>"
        const emitted = ex.push('<html>raw output</html>');
        assert.equal(emitted, '<html>raw output</html>');
        assert.equal(ex.isPlainText(), true);
    });

    test('truncated <think> with no closing tag yields empty extracted text', () => {
        const ex = createStreamingTextExtractor();
        const emitted = ex.push('<think>this thinking never finishes and the stream is cut');
        assert.equal(emitted, '');
        assert.equal(ex.finalize(), '');
    });
});
