'use strict';

// streamingTextExtractor.cjs — extract the value of the "text" JSON field from a
// streaming inference response.
//
// The cleanup model emits JSON like {"text":"...","editSummary":"..."}. We want
// the user to see the cleaned text materialize in real time, not the raw JSON.
// This module buffers partial input and emits decoded characters of the "text"
// value as they arrive.
//
// Behavior:
// - If the stream does not start with '{' (after whitespace) it falls back to
//   plain-text mode and emits the entire stream verbatim.
// - JSON string escapes (\n \t \r \b \f \" \\ \/ and \uXXXX) are decoded.
// - Keys other than "text" have their string values consumed and discarded.
// - Non-string values (numbers, bools, null, arrays, nested objects) are
//   skipped at the same nesting level.

const STATE_LOOKING_FOR_OBJECT = 'looking-for-object';
const STATE_MAYBE_THINK_OPEN = 'maybe-think-open';
const STATE_SKIPPING_THINK_BODY = 'skipping-think-body';
const STATE_LOOKING_FOR_KEY = 'looking-for-key';
const STATE_READING_KEY = 'reading-key';
const STATE_LOOKING_FOR_COLON = 'looking-for-colon';
const STATE_LOOKING_FOR_VALUE = 'looking-for-value';
const STATE_READING_TEXT_VALUE = 'reading-text-value';
const STATE_SKIPPING_STRING = 'skipping-string';
const STATE_SKIPPING_VALUE = 'skipping-value';
const STATE_DONE = 'done';
const STATE_PLAIN_TEXT = 'plain-text';

const THINK_OPEN_TAG = '<think>';
const THINK_CLOSE_TAG = '</think>';

const SIMPLE_ESCAPES = {
    'n': '\n',
    't': '\t',
    'r': '\r',
    'b': '\b',
    'f': '\f',
    '/': '/',
    '"': '"',
    '\\': '\\',
};

const createStreamingTextExtractor = () => {
    let state = STATE_LOOKING_FOR_OBJECT;
    let currentKey = '';
    let extractedText = '';
    let escapeNext = false;       // last char inside a string was a backslash
    let unicodeRemaining = 0;     // how many more hex digits to consume for \uXXXX
    let unicodeBuf = '';
    let nestingDepth = 0;
    let thinkPrefixBuf = '';      // accumulates chars while we test for "<think>"
    let thinkBodyBuf = '';        // last few chars of thinking body — for matching "</think>"

    const reset = () => {
        state = STATE_LOOKING_FOR_OBJECT;
        currentKey = '';
        extractedText = '';
        escapeNext = false;
        unicodeRemaining = 0;
        unicodeBuf = '';
        nestingDepth = 0;
        thinkPrefixBuf = '';
        thinkBodyBuf = '';
    };

    // Append decoded char to both emitted-this-call buffer and full text.
    const emit = (decoded, accumulator) => {
        accumulator.value += decoded;
        extractedText += decoded;
    };

    const push = (chunk) => {
        const input = String(chunk || '');
        if (!input) return '';

        const out = { value: '' };

        for (let i = 0; i < input.length; i++) {
            const ch = input[i];

            if (state === STATE_PLAIN_TEXT) {
                emit(ch, out);
                continue;
            }
            if (state === STATE_DONE) continue;

            // Inside a string value — handle \uXXXX continuation first.
            if (unicodeRemaining > 0) {
                unicodeBuf += ch;
                unicodeRemaining--;
                if (unicodeRemaining === 0) {
                    const code = parseInt(unicodeBuf, 16);
                    unicodeBuf = '';
                    if (Number.isFinite(code) && state === STATE_READING_TEXT_VALUE) {
                        emit(String.fromCharCode(code), out);
                    }
                }
                continue;
            }

            if (escapeNext) {
                escapeNext = false;
                if (ch === 'u') {
                    unicodeRemaining = 4;
                    unicodeBuf = '';
                    continue;
                }
                const decoded = SIMPLE_ESCAPES[ch] !== undefined ? SIMPLE_ESCAPES[ch] : ch;
                if (state === STATE_READING_TEXT_VALUE) {
                    emit(decoded, out);
                }
                continue;
            }

            if (state === STATE_LOOKING_FOR_OBJECT) {
                if (/\s/.test(ch)) continue;
                if (ch === '{') {
                    state = STATE_LOOKING_FOR_KEY;
                    nestingDepth = 1;
                    continue;
                }
                if (ch === '<') {
                    // Could be a <think>...</think> prelude emitted by reasoning-enabled
                    // models. Buffer until we either confirm the open tag or rule it out.
                    state = STATE_MAYBE_THINK_OPEN;
                    thinkPrefixBuf = ch;
                    continue;
                }
                // Not JSON and not a think-tag prelude — fall back to plain text.
                state = STATE_PLAIN_TEXT;
                emit(ch, out);
                continue;
            }

            if (state === STATE_MAYBE_THINK_OPEN) {
                thinkPrefixBuf += ch;
                if (thinkPrefixBuf === THINK_OPEN_TAG) {
                    state = STATE_SKIPPING_THINK_BODY;
                    thinkPrefixBuf = '';
                    thinkBodyBuf = '';
                    continue;
                }
                if (!THINK_OPEN_TAG.startsWith(thinkPrefixBuf)) {
                    // Buffered prefix is not heading toward "<think>" — flush as plain
                    // text and continue normally.
                    state = STATE_PLAIN_TEXT;
                    for (const buffered of thinkPrefixBuf) emit(buffered, out);
                    thinkPrefixBuf = '';
                    continue;
                }
                // Still a valid prefix of "<think>"; wait for more input.
                continue;
            }

            if (state === STATE_SKIPPING_THINK_BODY) {
                // Track the trailing chars to detect "</think>" without storing the
                // full body. Bounded to THINK_CLOSE_TAG.length so memory stays flat.
                thinkBodyBuf = (thinkBodyBuf + ch).slice(-THINK_CLOSE_TAG.length);
                if (thinkBodyBuf === THINK_CLOSE_TAG) {
                    state = STATE_LOOKING_FOR_OBJECT;
                    thinkBodyBuf = '';
                }
                continue;
            }

            if (state === STATE_LOOKING_FOR_KEY) {
                if (/\s|,/.test(ch)) continue;
                if (ch === '}') {
                    state = STATE_DONE;
                    continue;
                }
                if (ch === '"') {
                    state = STATE_READING_KEY;
                    currentKey = '';
                }
                continue;
            }

            if (state === STATE_READING_KEY) {
                if (ch === '\\') {
                    escapeNext = true;
                    continue;
                }
                if (ch === '"') {
                    state = STATE_LOOKING_FOR_COLON;
                    continue;
                }
                currentKey += ch;
                continue;
            }

            if (state === STATE_LOOKING_FOR_COLON) {
                if (/\s/.test(ch)) continue;
                if (ch === ':') state = STATE_LOOKING_FOR_VALUE;
                continue;
            }

            if (state === STATE_LOOKING_FOR_VALUE) {
                if (/\s/.test(ch)) continue;
                if (ch === '"') {
                    state = currentKey === 'text' ? STATE_READING_TEXT_VALUE : STATE_SKIPPING_STRING;
                    continue;
                }
                // Non-string value: number/bool/null or array/object. Skip until comma
                // or closing brace at depth 1.
                state = STATE_SKIPPING_VALUE;
                if (ch === '{' || ch === '[') nestingDepth++;
                continue;
            }

            if (state === STATE_READING_TEXT_VALUE) {
                if (ch === '\\') {
                    escapeNext = true;
                    continue;
                }
                if (ch === '"') {
                    state = STATE_LOOKING_FOR_KEY;
                    currentKey = '';
                    continue;
                }
                emit(ch, out);
                continue;
            }

            if (state === STATE_SKIPPING_STRING) {
                if (ch === '\\') {
                    escapeNext = true;
                    continue;
                }
                if (ch === '"') {
                    state = STATE_LOOKING_FOR_KEY;
                    currentKey = '';
                }
                continue;
            }

            if (state === STATE_SKIPPING_VALUE) {
                if (ch === '{' || ch === '[') {
                    nestingDepth++;
                    continue;
                }
                if (ch === '}' || ch === ']') {
                    nestingDepth--;
                    if (nestingDepth <= 1) {
                        state = STATE_LOOKING_FOR_KEY;
                        currentKey = '';
                    }
                    continue;
                }
                if (ch === ',' && nestingDepth === 1) {
                    state = STATE_LOOKING_FOR_KEY;
                    currentKey = '';
                }
            }
        }

        return out.value;
    };

    const finalize = () => extractedText;
    const isPlainText = () => state === STATE_PLAIN_TEXT;

    return { push, finalize, reset, isPlainText };
};

module.exports = {
    createStreamingTextExtractor,
};
