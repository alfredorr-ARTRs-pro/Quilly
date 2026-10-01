'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const liveLlmService = require('./liveLlmService.cjs');

describe('liveLlmService final structure rules', () => {
    test('splits natural spoken point numbering into separate paragraphs', () => {
        const input = [
            'I am not sure how to test this.',
            'So, point number one, it should separate paragraphs.',
            'Two, it should make separate lines.',
            'Three, it should understand context.',
        ].join(' ');

        const output = liveLlmService.structureFinalText(input);

        assert.match(output, /1\. it should separate paragraphs\./i);
        assert.match(output, /\n\n2\. it should make separate lines\./i);
        assert.match(output, /\n\n3\. it should understand context\./i);
    });

    test('splits decimal-like point markers into paragraphs', () => {
        const output = liveLlmService.structureFinalText(
            'Here are the items 0.1 first thing 0.2 second thing 0.3 third thing'
        );

        assert.match(output, /1\. first thing/i);
        assert.match(output, /\n\n2\. second thing/i);
        assert.match(output, /\n\n3\. third thing/i);
    });

    test('uses custom phrase break cues', () => {
        const output = liveLlmService.structureFinalText(
            'The dot is working another section this should start fresh',
            {
                phraseBreakCues: ['another section'],
            }
        );

        assert.match(output, /working\n\nanother section this should start fresh/i);
    });

    test('uses custom numbered cue phrases', () => {
        const output = liveLlmService.structureFinalText(
            'Here are the items item one apples item two oranges',
            {
                numberedPointCues: ['item'],
            }
        );

        assert.match(output, /1\. apples/i);
        assert.match(output, /\n\n2\. oranges/i);
    });

    test('applies custom exact phrase replacements before structure cleanup', () => {
        const output = liveLlmService.structureFinalText(
            'The bottom pulses when the Microsoft is recording.',
            {
                customReplacements: [
                    { from: 'bottom', to: 'button' },
                    { from: 'Microsoft', to: 'microphone' },
                ],
            }
        );

        assert.match(output, /The button pulses/i);
        assert.match(output, /the microphone is recording/i);
    });
});

describe('liveLlmService final cleanup output parsing', () => {
    test('accepts preferred JSON output', () => {
        const parsed = liveLlmService._internal.parseFinalCleanupOutput(
            '{"text":"Cleaned text.","editSummary":"fixed punctuation"}'
        );

        assert.equal(parsed.text, 'Cleaned text.');
        assert.equal(parsed.editSummary, 'fixed punctuation');
        assert.equal(parsed.responseFormat, 'json');
    });

    test('accepts plain text output when cleanup output ignores JSON', () => {
        const parsed = liveLlmService._internal.parseFinalCleanupOutput(
            'First paragraph.\n\nSecond paragraph.'
        );

        assert.equal(parsed.text, 'First paragraph.\n\nSecond paragraph.');
        assert.equal(parsed.editSummary, 'tiny final cleanup plain text');
        assert.equal(parsed.responseFormat, 'plain-text');
    });
});

describe('stripThinkBlocks', () => {
    test('removes balanced <think>...</think> pairs', () => {
        const result = liveLlmService._internal.stripThinkBlocks(
            '<think>some reasoning</think>{"text":"final"}'
        );
        assert.equal(result, '{"text":"final"}');
    });

    test('removes multiple balanced pairs', () => {
        const result = liveLlmService._internal.stripThinkBlocks(
            'before<think>one</think>middle<think>two</think>after'
        );
        assert.equal(result, 'beforemiddleafter');
    });

    test('drops everything from an unbalanced <think> with no closing tag', () => {
        const result = liveLlmService._internal.stripThinkBlocks(
            '{"text":"good answer"}<think>truncated thinking that never ends'
        );
        assert.equal(result, '{"text":"good answer"}');
    });

    test('returns empty string when entire output is unclosed thinking', () => {
        const result = liveLlmService._internal.stripThinkBlocks(
            '<think>just thinking, never produced an answer'
        );
        assert.equal(result, '');
    });

    test('passes through text with no think blocks', () => {
        const result = liveLlmService._internal.stripThinkBlocks(
            '{"text":"hello world"}'
        );
        assert.equal(result, '{"text":"hello world"}');
    });
});

describe('stripWhisperArtifacts', () => {
    test('strips trailing [BLANK_AUDIO] annotation', () => {
        const result = liveLlmService.stripWhisperArtifacts(
            "Let's see how it works [BLANK_AUDIO]"
        );
        assert.equal(result, "Let's see how it works");
    });

    test('strips [Music] / [Applause] / [Laughter] annotations', () => {
        for (const tag of ['Music', 'Applause', 'Laughter']) {
            const result = liveLlmService.stripWhisperArtifacts(
                `Hello [${tag}] world.`
            );
            assert.equal(result, 'Hello world.');
        }
    });

    test('collapses double spaces left behind by stripping', () => {
        const result = liveLlmService.stripWhisperArtifacts(
            'Hello [BLANK_AUDIO]  world.'
        );
        assert.equal(result, 'Hello world.');
    });

    test('does not strip ordinary bracketed user content', () => {
        const result = liveLlmService.stripWhisperArtifacts(
            'See the [draft] section for details.'
        );
        assert.equal(result, 'See the [draft] section for details.');
    });

    test('passes through text with no artifacts', () => {
        const result = liveLlmService.stripWhisperArtifacts(
            'A plain sentence with no artifacts.'
        );
        assert.equal(result, 'A plain sentence with no artifacts.');
    });
});
