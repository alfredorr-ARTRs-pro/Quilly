'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const liveTranscriptService = require('./liveTranscriptService.cjs');

describe('liveTranscriptService', () => {
    beforeEach(() => {
        liveTranscriptService.resetSession();
    });

    test('defaults to raw live preview without cutting spoken text', () => {
        liveTranscriptService.startSession({ sessionId: 's1' });
        const state = liveTranscriptService.updateFromChunk({
            sessionId: 's1',
            chunkText: 'um Quilly translate this to Spanish hello world period',
            startMs: 0,
            endMs: 2500,
        });

        assert.equal(state.rawTranscript, 'um Quilly translate this to Spanish hello world period');
        assert.equal(state.visibleDraft, 'um Quilly translate this to Spanish hello world period');
        assert.match(state.instructionBuffer, /translate/i);
    });

    test('rules mode preserves raw transcript while producing a cleaned visible draft', () => {
        liveTranscriptService.startSession({ sessionId: 's1', cleanupSource: 'rules' });
        const state = liveTranscriptService.updateFromChunk({
            sessionId: 's1',
            chunkText: 'um Quilly translate this to Spanish hello world period',
            startMs: 0,
            endMs: 2500,
            cleanupSource: 'rules',
            commit: true,
        });

        assert.equal(state.rawTranscript, 'um Quilly translate this to Spanish hello world period');
        assert.equal(state.visibleDraft, 'Quilly translate this to Spanish hello world.');
        assert.match(state.instructionBuffer, /translate/i);
    });

    test('converts spoken punctuation and emoji phrases', () => {
        liveTranscriptService.startSession({ sessionId: 's1', cleanupSource: 'rules' });
        const state = liveTranscriptService.updateFromChunk({
            sessionId: 's1',
            chunkText: 'are we good question mark happy face',
            startMs: 0,
            endMs: 2500,
            cleanupSource: 'rules',
            commit: true,
        });

        assert.equal(state.visibleDraft, 'are we good? \u{1F642}');
    });

    test('handles simple no-sorry self corrections', () => {
        liveTranscriptService.startSession({ sessionId: 's1', cleanupSource: 'rules' });
        const state = liveTranscriptService.updateFromChunk({
            sessionId: 's1',
            chunkText: 'let us meet Monday no sorry Tuesday at four',
            startMs: 0,
            endMs: 2500,
            cleanupSource: 'rules',
            commit: true,
        });

        assert.equal(state.visibleDraft, 'let us meet Tuesday at four');
    });

    test('handles no-no sentence restarts by keeping the repeated replacement phrase', () => {
        liveTranscriptService.startSession({ sessionId: 's1', cleanupSource: 'rules' });
        const state = liveTranscriptService.updateFromChunk({
            sessionId: 's1',
            chunkText: 'we need to meet on Monday no no we need to meet on Tuesday',
            startMs: 0,
            endMs: 2500,
            cleanupSource: 'rules',
            commit: true,
        });

        assert.equal(state.rawTranscript, 'we need to meet on Monday no no we need to meet on Tuesday');
        assert.equal(state.visibleDraft, 'we need to meet on Tuesday');
    });

    test('removes adjacent duplicate repeated phrases', () => {
        liveTranscriptService.startSession({ sessionId: 's1', cleanupSource: 'rules' });
        const state = liveTranscriptService.updateFromChunk({
            sessionId: 's1',
            chunkText: 'please add the phrase please add the phrase to the box',
            startMs: 0,
            endMs: 2500,
            cleanupSource: 'rules',
            commit: true,
        });

        assert.equal(state.visibleDraft, 'please add the phrase to the box');
    });

    test('applies delete-from-anchor commands only to visible draft', () => {
        liveTranscriptService.startSession({ sessionId: 's1', cleanupSource: 'rules' });
        const state = liveTranscriptService.updateFromChunk({
            sessionId: 's1',
            chunkText: 'keep the first sentence remove this part delete that from remove on add the ending',
            startMs: 0,
            endMs: 2500,
            cleanupSource: 'rules',
            commit: true,
        });

        assert.equal(state.rawTranscript, 'keep the first sentence remove this part delete that from remove on add the ending');
        assert.equal(state.visibleDraft, 'keep the first sentence add the ending');
    });

    test('deduplicates overlapping rolling chunks', () => {
        liveTranscriptService.startSession({ sessionId: 's1' });
        liveTranscriptService.updateFromChunk({
            sessionId: 's1',
            chunkText: 'hello world this is',
            startMs: 0,
            endMs: 2500,
        });
        const state = liveTranscriptService.updateFromChunk({
            sessionId: 's1',
            chunkText: 'this is a live draft',
            startMs: 1500,
            endMs: 4000,
        });

        assert.equal(state.rawTranscript, 'hello world this is a live draft');
        assert.equal(state.visibleDraft, 'hello world this is a live draft');
    });

    test('keeps new words tentative until a commit', () => {
        liveTranscriptService.startSession({ sessionId: 's1' });
        let state = liveTranscriptService.updateFromChunk({
            sessionId: 's1',
            chunkText: 'let us try one shot',
            startMs: 0,
            endMs: 2000,
        });

        assert.equal(state.stableVisibleDraft, '');
        assert.equal(state.tentativeDraft, 'let us try one shot');

        state = liveTranscriptService.updateFromChunk({
            sessionId: 's1',
            chunkText: 'let us try one shot no two shots',
            startMs: 0,
            endMs: 4200,
            commit: true,
        });

        assert.equal(state.committed, true);
        assert.equal(state.stableRawTranscript, 'let us try one shot no two shots');
        assert.equal(state.tentativeDraft, '');
    });

    test('rules cleanup applies on committed stable text, not tentative text', () => {
        liveTranscriptService.startSession({ sessionId: 's1', cleanupSource: 'rules' });
        let state = liveTranscriptService.updateFromChunk({
            sessionId: 's1',
            chunkText: 'let us try one shot no two shots',
            startMs: 0,
            endMs: 3000,
            cleanupSource: 'rules',
        });

        assert.equal(state.visibleDraft, 'let us try one shot no two shots');
        assert.equal(state.tentativeDraft, 'let us try one shot no two shots');

        state = liveTranscriptService.updateFromChunk({
            sessionId: 's1',
            chunkText: 'let us try one shot no two shots',
            startMs: 0,
            endMs: 4200,
            cleanupSource: 'rules',
            commit: true,
        });

        assert.equal(state.stableVisibleDraft, 'let us try two shots');
        assert.equal(state.visibleDraft, 'let us try two shots');
    });

    test('ignores stale chunks', () => {
        liveTranscriptService.startSession({ sessionId: 's1' });
        liveTranscriptService.updateFromChunk({
            sessionId: 's1',
            chunkText: 'new words',
            startMs: 0,
            endMs: 3000,
        });
        const state = liveTranscriptService.updateFromChunk({
            sessionId: 's1',
            chunkText: 'old words',
            startMs: 0,
            endMs: 2000,
        });

        assert.equal(state.ignored, true);
        assert.equal(state.ignoreReason, 'stale');
        assert.equal(state.rawTranscript, 'new words');
    });

    test('finalizeSession returns raw final text in raw mode', () => {
        liveTranscriptService.startSession({ sessionId: 's1' });
        liveTranscriptService.updateFromChunk({
            sessionId: 's1',
            chunkText: 'rough text',
            startMs: 0,
            endMs: 2000,
        });
        const state = liveTranscriptService.finalizeSession({
            sessionId: 's1',
            finalRawText: 'um final text question mark',
            mode: 'transcribe',
            cleanupSource: 'raw',
        });

        assert.equal(state.finalRawText, 'um final text question mark');
        assert.equal(state.finalVisibleDraft, 'um final text question mark');
        assert.equal(state.mode, 'transcribe');
    });

    test('finalizeSession can still return cleaned final text in rules mode', () => {
        liveTranscriptService.startSession({ sessionId: 's1', cleanupSource: 'rules' });
        const state = liveTranscriptService.finalizeSession({
            sessionId: 's1',
            finalRawText: 'um final text question mark',
            mode: 'transcribe',
            cleanupSource: 'rules',
        });

        assert.equal(state.finalRawText, 'um final text question mark');
        assert.equal(state.finalVisibleDraft, 'final text?');
    });

    test('ignores suspicious tiny-helper output and keeps rule-cleaned draft', () => {
        liveTranscriptService.startSession({ sessionId: 's1' });
        liveTranscriptService.updateFromChunk({
            sessionId: 's1',
            chunkText: 'please send the project update to Sarah after lunch',
            startMs: 0,
            endMs: 2500,
        });

        const state = liveTranscriptService.applyHelperResult({
            sessionId: 's1',
            visibleDraft: 'ok',
            instructionBuffer: '',
            stableUntilMs: 2500,
        });

        assert.equal(state.ignored, true);
        assert.equal(state.ignoreReason, 'short-helper-result');
        assert.equal(state.visibleDraft, 'please send the project update to Sarah after lunch');
    });
});
