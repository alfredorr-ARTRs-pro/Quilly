'use strict';

// liveTranscriptService.cjs
//
// Pure state/service layer for live dictation drafts. It preserves the raw
// Whisper transcript separately from the visible cleaned draft so final LLM
// processing can still receive the user's full spoken instructions.

const DEFAULT_STATE = {
    sessionId: null,
    rawTranscript: '',
    visibleDraft: '',
    stableRawTranscript: '',
    stableVisibleDraft: '',
    tentativeTranscript: '',
    tentativeDraft: '',
    instructionBuffer: '',
    stableUntilMs: 0,
    lastChunkEndMs: 0,
    chunks: [],
    status: 'idle',
    cleanupSource: 'raw',
    editSummary: '',
};

let _state = { ...DEFAULT_STATE };

const cloneState = (extra = {}) => ({
    ..._state,
    chunks: _state.chunks.map(chunk => ({ ...chunk })),
    ...extra,
});

const normalizeWhitespace = (text) =>
    String(text || '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

const normalizeForCompare = (text) =>
    String(text || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s'-]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();

const splitWords = (text) => normalizeForCompare(text).split(' ').filter(Boolean);

const countWords = (text) => splitWords(text).length;

const findLastSentenceBoundary = (text) => {
    const indexes = ['.', '!', '?', '\n'].map(marker => text.lastIndexOf(marker));
    return Math.max(-1, ...indexes);
};

const commonLeadingWords = (left, right) => {
    const leftWords = splitWords(left);
    const rightWords = splitWords(right);
    const max = Math.min(leftWords.length, rightWords.length, 12);
    let count = 0;
    while (count < max && leftWords[count] === rightWords[count]) {
        count++;
    }
    return count;
};

const mergeTranscriptText = (existing, incoming) => {
    const base = normalizeWhitespace(existing);
    const next = normalizeWhitespace(incoming);

    if (!next) return base;
    if (!base) return next;

    const baseNorm = normalizeForCompare(base);
    const nextNorm = normalizeForCompare(next);

    if (!nextNorm) return base;
    if (baseNorm.includes(nextNorm)) return base;
    if (nextNorm.includes(baseNorm)) return next;

    const baseWords = splitWords(base);
    const nextWords = splitWords(next);
    const maxOverlap = Math.min(baseWords.length, nextWords.length, 24);

    for (let size = maxOverlap; size > 0; size--) {
        const left = baseWords.slice(baseWords.length - size).join(' ');
        const right = nextWords.slice(0, size).join(' ');
        if (left === right) {
            const originalNextWords = next.split(/\s+/).filter(Boolean);
            return normalizeWhitespace(`${base} ${originalNextWords.slice(size).join(' ')}`);
        }
    }

    return normalizeWhitespace(`${base} ${next}`);
};

const getTentativeTail = (stableText, tentativeText) => {
    const stable = normalizeWhitespace(stableText);
    const tentative = normalizeWhitespace(tentativeText);

    if (!tentative) return '';
    if (!stable) return tentative;

    const stableNorm = normalizeForCompare(stable);
    const tentativeNorm = normalizeForCompare(tentative);

    if (!tentativeNorm || stableNorm.includes(tentativeNorm)) {
        return '';
    }

    const stableWords = splitWords(stable);
    const tentativeWords = splitWords(tentative);
    const originalTentativeWords = tentative.split(/\s+/).filter(Boolean);

    if (tentativeNorm.includes(stableNorm)) {
        return normalizeWhitespace(originalTentativeWords.slice(stableWords.length).join(' '));
    }

    const maxOverlap = Math.min(stableWords.length, tentativeWords.length, 32);
    for (let size = maxOverlap; size > 0; size--) {
        const left = stableWords.slice(stableWords.length - size).join(' ');
        const right = tentativeWords.slice(0, size).join(' ');
        if (left === right) {
            return normalizeWhitespace(originalTentativeWords.slice(size).join(' '));
        }
    }

    return tentative;
};

const combineDrafts = (stableDraft, tentativeDraft) =>
    normalizeWhitespace([stableDraft, tentativeDraft].filter(Boolean).join(' '));

const replacePhrase = (text, phrase, replacement) => {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return text.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), replacement);
};

const applySpokenSymbols = (text) => {
    let result = text;

    const symbolMap = [
        ['new paragraph', '\n\n'],
        ['new line', '\n'],
        ['line break', '\n'],
        ['question mark', '?'],
        ['exclamation mark', '!'],
        ['exclamation point', '!'],
        ['period', '.'],
        ['full stop', '.'],
        ['comma', ','],
        ['colon', ':'],
        ['semicolon', ';'],
        ['dash', '-'],
        ['open parenthesis', '('],
        ['close parenthesis', ')'],
        ['left parenthesis', '('],
        ['right parenthesis', ')'],
        ['happy face emoji', '\u{1F642}'],
        ['happy face', '\u{1F642}'],
        ['smiley face', '\u{1F642}'],
        ['sad face emoji', '\u{1F641}'],
        ['sad face', '\u{1F641}'],
        ['thumbs up emoji', '\u{1F44D}'],
        ['thumbs up', '\u{1F44D}'],
        ['heart emoji', '\u{2764}\u{FE0F}'],
    ];

    for (const [phrase, replacement] of symbolMap) {
        result = replacePhrase(result, phrase, replacement);
    }

    return result;
};

const removeFillers = (text) =>
    text
        .replace(/\b(?:um+|uh+|erm+|er+|hmm+|ah+)\b[,\s]*/gi, '')
        .replace(/\b(?:you know)\b[,\s]*/gi, '');

const applyRestartCorrections = (text) => {
    let result = text;
    const markerPattern = /\b(?:no\s+no|no\s+wait|no\s+sorry|i\s+mean|rather)\b/iu;

    for (let i = 0; i < 8; i++) {
        const match = result.match(markerPattern);
        if (!match || match.index == null) break;

        const before = result.slice(0, match.index).trimEnd();
        const after = result.slice(match.index + match[0].length).trimStart();
        if (countWords(after) < 2) break;

        const boundary = findLastSentenceBoundary(before);
        const prefix = before.slice(0, boundary + 1).trim();
        const currentSentence = before.slice(boundary + 1).trim();

        if (countWords(currentSentence) >= 2 && commonLeadingWords(currentSentence, after) >= 2) {
            result = normalizeWhitespace(`${prefix ? `${prefix} ` : ''}${after}`);
            continue;
        }

        break;
    }

    return result;
};

const removeAdjacentDuplicatePhrases = (text) => {
    let result = text;

    for (let size = 8; size >= 2; size--) {
        const pattern = new RegExp(
            `\\b((?:[\\p{L}\\p{N}'-]+\\s+){${size - 1}}[\\p{L}\\p{N}'-]+)\\s+\\1\\b`,
            'giu'
        );
        result = result.replace(pattern, '$1');
    }

    return result;
};

const applySimpleCorrections = (text) => {
    let result = applyRestartCorrections(text);

    // "one shot no two shots" -> "two shots"
    result = result.replace(
        /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+([\p{L}\p{N}'-]+)s?\s+(?:no(?:\s+(?:sorry|wait|no))?|sorry|i mean|rather)\s+((?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+[\p{L}\p{N}'-]+s?)\b/giu,
        '$2'
    );

    // "Monday no sorry Tuesday" -> "Tuesday"
    result = result.replace(/\b([\p{L}\p{N}'-]+)\s*,?\s+(?:no\s+(?:sorry|wait|no)|sorry|i mean|rather)\s+([\p{L}\p{N}'-]+)\b/giu, '$2');

    // Remove leftover spoken restart markers when they were used as corrections.
    result = result.replace(/\b(?:no\s+no|no\s+wait|no\s+sorry)\b[,\s]*/giu, '');

    result = removeAdjacentDuplicatePhrases(result);

    // "scratch that ..." drops everything before the correction phrase.
    result = result.replace(/^[\s\S]*?\bscratch that\b[,\s]*/i, '');

    // "forget that ..." behaves like "scratch that" when used as a correction.
    result = result.replace(/^[\s\S]*?\bforget that\b[,\s]*/i, '');

    return result;
};

const applyAnchorDeletion = (text) => {
    const match = text.match(/^(?<before>[\s\S]*?)\bdelete that from\s+(?<anchor>[\s\S]{1,80}?)\s+on\b(?<after>[\s\S]*)$/i);
    if (!match?.groups) return text;

    const before = match.groups.before.trim();
    const anchor = normalizeWhitespace(match.groups.anchor);
    const after = match.groups.after.trim();
    const beforeLower = before.toLowerCase();
    const anchorLower = anchor.toLowerCase();
    const anchorIdx = beforeLower.lastIndexOf(anchorLower);

    if (anchorIdx === -1) {
        return normalizeWhitespace(`${before} ${after}`);
    }

    return normalizeWhitespace(`${before.slice(0, anchorIdx)} ${after}`);
};

const tidyPunctuation = (text) =>
    text
        .replace(/\s+([,.;:!?])/g, '$1')
        .replace(/([(\[])\s+/g, '$1')
        .replace(/\s+([)\]])/g, '$1')
        .replace(/([,.;:!?])(?=\S)/g, '$1 ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n');

const extractInstructionBuffer = (rawText) => {
    const instructionPattern = /\b(?:quilly|translate|rewrite|summarize|summarise|analyze|analyse|format|make|turn|change|replace|delete|scratch|fix|correct|polish|professional|formal|email|report|bullet|bullets)\b/i;
    const sentences = String(rawText || '')
        .split(/(?<=[.!?])\s+|\n+/)
        .map(s => s.trim())
        .filter(Boolean);

    return sentences.filter(sentence => instructionPattern.test(sentence)).join(' ');
};

const cleanupWithRules = (rawText) => {
    let result = normalizeWhitespace(rawText);
    if (!result) {
        return { visibleDraft: '', editSummary: 'empty' };
    }

    result = removeFillers(result);
    result = applySimpleCorrections(result);
    result = applyAnchorDeletion(result);
    result = applySpokenSymbols(result);
    result = tidyPunctuation(result);
    result = normalizeWhitespace(result);

    return {
        visibleDraft: result,
        editSummary: 'rule cleanup',
    };
};

const normalizeCleanupSource = (source) =>
    ['raw', 'rules', 'tiny-llm', 'fallback'].includes(source) ? source : 'raw';

const cleanupForMode = (rawText, cleanupSource = 'raw') => {
    const source = normalizeCleanupSource(cleanupSource);
    if (source === 'rules') {
        return cleanupWithRules(rawText);
    }

    const visibleDraft = normalizeWhitespace(rawText);
    return {
        visibleDraft,
        editSummary: visibleDraft ? 'raw live transcript' : 'empty',
    };
};

const ensureSession = (sessionId) => {
    if (!_state.sessionId || _state.sessionId !== sessionId) {
        startSession({ sessionId });
    }
};

const startSession = ({ sessionId, cleanupSource = 'raw' } = {}) => {
    const id = sessionId || `live-${Date.now()}`;
    _state = {
        ...DEFAULT_STATE,
        sessionId: id,
        status: 'listening',
        cleanupSource: normalizeCleanupSource(cleanupSource),
    };
    return cloneState();
};

const updateFromChunk = ({ sessionId, chunkText, startMs = 0, endMs = 0, cleanupSource = null, commit = false } = {}) => {
    ensureSession(sessionId);

    const normalizedChunk = normalizeWhitespace(chunkText);
    if (!normalizedChunk) {
        return cloneState({ ignored: true, ignoreReason: 'empty' });
    }

    if (endMs && endMs <= Math.max(_state.stableUntilMs, _state.lastChunkEndMs)) {
        return cloneState({ ignored: true, ignoreReason: 'stale' });
    }

    const source = normalizeCleanupSource(cleanupSource || _state.cleanupSource);
    const stableSource = source === 'rules' ? 'rules' : 'raw';
    if (commit === true) {
        const stableRawTranscript = mergeTranscriptText(_state.rawTranscript || _state.stableRawTranscript, normalizedChunk);
        const cleaned = cleanupForMode(stableRawTranscript, stableSource);

        _state = {
            ..._state,
            rawTranscript: stableRawTranscript,
            visibleDraft: cleaned.visibleDraft,
            stableRawTranscript,
            stableVisibleDraft: cleaned.visibleDraft,
            tentativeTranscript: '',
            tentativeDraft: '',
            instructionBuffer: extractInstructionBuffer(stableRawTranscript),
            stableUntilMs: Math.max(_state.stableUntilMs, endMs || 0),
            lastChunkEndMs: Math.max(_state.lastChunkEndMs, endMs || 0),
            chunks: [
                ..._state.chunks,
                { text: normalizedChunk, startMs: startMs || 0, endMs: endMs || 0, committed: true },
            ].slice(-50),
            status: 'listening',
            cleanupSource: stableSource,
            editSummary: cleaned.editSummary,
        };

        return cloneState({ committed: true });
    }

    const stableVisibleDraft = _state.stableVisibleDraft ||
        cleanupForMode(_state.stableRawTranscript, stableSource).visibleDraft;
    const rawTranscript = mergeTranscriptText(_state.rawTranscript || _state.stableRawTranscript, normalizedChunk);
    const tentativeDraft = getTentativeTail(_state.stableRawTranscript, rawTranscript);
    const visibleDraft = combineDrafts(stableVisibleDraft, tentativeDraft);

    _state = {
        ..._state,
        rawTranscript,
        visibleDraft,
        stableVisibleDraft,
        tentativeTranscript: normalizedChunk,
        tentativeDraft,
        instructionBuffer: extractInstructionBuffer(rawTranscript),
        lastChunkEndMs: Math.max(_state.lastChunkEndMs, endMs || 0),
        chunks: [
            ..._state.chunks,
            { text: normalizedChunk, startMs: startMs || 0, endMs: endMs || 0, committed: false },
        ].slice(-50),
        status: 'listening',
        cleanupSource: source === 'tiny-llm' ? 'raw' : stableSource,
        editSummary: 'tentative live transcript',
    };

    return cloneState();
};

const applyHelperResult = ({ sessionId, visibleDraft, instructionBuffer, stableUntilMs, editSummary } = {}) => {
    ensureSession(sessionId);

    const cleanedDraft = normalizeWhitespace(visibleDraft);
    if (!cleanedDraft) {
        return cloneState({ ignored: true, ignoreReason: 'empty-helper-result' });
    }

    const currentDraft = normalizeWhitespace(_state.visibleDraft);
    const currentWords = countWords(currentDraft);
    const helperWords = countWords(cleanedDraft);
    const hasJsonArtifacts = /"visibleDraft"|"instructionBuffer"|^\s*[{[]/.test(cleanedDraft);
    const hasAssistantDisclaimer = /\b(?:as an ai|i cannot|i can't|sorry,? but)\b/i.test(cleanedDraft);

    if (hasJsonArtifacts || hasAssistantDisclaimer) {
        return cloneState({ ignored: true, ignoreReason: 'suspicious-helper-result' });
    }

    if (currentWords >= 8 && helperWords < Math.ceil(currentWords * 0.55)) {
        return cloneState({ ignored: true, ignoreReason: 'short-helper-result' });
    }

    _state = {
        ..._state,
        visibleDraft: combineDrafts(cleanedDraft, _state.tentativeDraft),
        stableVisibleDraft: cleanedDraft,
        instructionBuffer: normalizeWhitespace(instructionBuffer || _state.instructionBuffer),
        stableUntilMs: Math.max(_state.stableUntilMs, stableUntilMs || 0),
        status: 'listening',
        cleanupSource: 'tiny-llm',
        editSummary: editSummary || 'tiny helper cleanup',
    };

    return cloneState();
};

const applyFinalTranscript = ({ sessionId, finalRawText, cleanupSource = null } = {}) => {
    ensureSession(sessionId);

    const rawTranscript = normalizeWhitespace(finalRawText || _state.rawTranscript);
    const source = normalizeCleanupSource(cleanupSource || _state.cleanupSource);
    const finalSource = source === 'rules' ? 'rules' : 'raw';
    const cleaned = cleanupForMode(rawTranscript, finalSource);

    _state = {
        ..._state,
        rawTranscript,
        visibleDraft: cleaned.visibleDraft,
        stableRawTranscript: rawTranscript,
        stableVisibleDraft: cleaned.visibleDraft,
        tentativeTranscript: '',
        tentativeDraft: '',
        instructionBuffer: extractInstructionBuffer(rawTranscript),
        stableUntilMs: Number.MAX_SAFE_INTEGER,
        status: 'listening',
        cleanupSource: finalSource,
        editSummary: cleaned.editSummary,
    };

    return cloneState();
};

const finalizeSession = ({ sessionId, finalRawText, mode = 'transcribe', cleanupSource = null } = {}) => {
    const state = applyFinalTranscript({ sessionId, finalRawText, cleanupSource });
    return {
        ...state,
        mode,
        finalRawText: state.rawTranscript,
        finalVisibleDraft: state.visibleDraft,
    };
};

const resetSession = () => {
    _state = { ...DEFAULT_STATE };
    return cloneState();
};

const getState = () => cloneState();

module.exports = {
    startSession,
    updateFromChunk,
    applyHelperResult,
    applyFinalTranscript,
    finalizeSession,
    resetSession,
    getState,
    _internal: {
        cleanupWithRules,
        cleanupForMode,
        getTentativeTail,
        mergeTranscriptText,
        extractInstructionBuffer,
    },
};
