'use strict';

// Tests for electron/intentRouter.cjs internal functions
// Uses Node.js built-in test runner: node --test electron/intentRouter.test.cjs
//
// These tests exercise the _internal API exported by intentRouter.cjs:
//   { tokenize, levenshtein, findWakeWord, splitContentFromInstruction,
//     findIntentKeyword, extractLanguage }
// And the public API:
//   route(text, defaultLanguage)

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
    route,
    _internal: {
        tokenize,
        levenshtein,
        findWakeWord,
        splitContentFromInstruction,
        findIntentKeyword,
        extractLanguage,
    },
} = require('./intentRouter.cjs');

// ─── tokenize ─────────────────────────────────────────────────────────────────

describe('tokenize', () => {
    test('splits on whitespace and lowercases', () => {
        assert.deepStrictEqual(tokenize('Hello World'), ['hello', 'world']);
    });

    test('strips leading/trailing punctuation', () => {
        assert.deepStrictEqual(tokenize('Quilly,'), ['quilly']);
    });

    test('handles Unicode punctuation', () => {
        assert.deepStrictEqual(tokenize('übersetzen.'), ['übersetzen']);
    });

    test('preserves accented chars', () => {
        assert.deepStrictEqual(tokenize('à français'), ['à', 'français']);
    });

    test('filters empty tokens from extra whitespace', () => {
        assert.deepStrictEqual(tokenize('  hello   world  '), ['hello', 'world']);
    });

    test('handles CJK characters', () => {
        assert.deepStrictEqual(tokenize('翻訳して'), ['翻訳して']);
    });
});

// ─── levenshtein ──────────────────────────────────────────────────────────────

describe('levenshtein', () => {
    test('identical strings return 0', () => {
        assert.strictEqual(levenshtein('quilly', 'quilly'), 0);
    });

    test('single insertion: quilley is distance 1 from quilly', () => {
        assert.strictEqual(levenshtein('quilley', 'quilly'), 1);
    });

    test('single substitution: quilly vs quillx is distance 1', () => {
        assert.strictEqual(levenshtein('quilly', 'quillx'), 1);
    });

    test('distance 2: chilly vs quilly', () => {
        assert.strictEqual(levenshtein('chilly', 'quilly'), 2);
    });

    test('empty string to non-empty: distance equals length', () => {
        assert.strictEqual(levenshtein('', 'quilly'), 6);
    });

    test('both empty strings return 0', () => {
        assert.strictEqual(levenshtein('', ''), 0);
    });
});

// ─── findWakeWord ─────────────────────────────────────────────────────────────

describe('findWakeWord', () => {
    test('finds exact "quilly" at index 1', () => {
        assert.strictEqual(findWakeWord(['hello', 'quilly', 'world']), 1);
    });

    test('finds distance-1 variant "quilley"', () => {
        const idx = findWakeWord(['translate', 'quilley', 'this']);
        assert.ok(idx >= 0, `Expected index >= 0, got ${idx}`);
        assert.strictEqual(idx, 1);
    });

    test('finds distance-2 variant "killy"', () => {
        const idx = findWakeWord(['killy', 'translate', 'this']);
        assert.ok(idx >= 0, `Expected index >= 0, got ${idx}`);
        assert.strictEqual(idx, 0);
    });

    test('rejects "chilly" (distance 2 but in exclusion list)', () => {
        assert.strictEqual(findWakeWord(['chilly', 'translate', 'this']), -1);
    });

    test('rejects "quickly" (in exclusion list)', () => {
        assert.strictEqual(findWakeWord(['quickly', 'do', 'this']), -1);
    });

    test('rejects "silly" (in exclusion list)', () => {
        assert.strictEqual(findWakeWord(['silly', 'joke']), -1);
    });

    test('rejects "billy" (in exclusion list)', () => {
        assert.strictEqual(findWakeWord(['billy', 'said']), -1);
    });

    test('rejects "hilly" (in exclusion list)', () => {
        assert.strictEqual(findWakeWord(['hilly', 'terrain']), -1);
    });

    test('rejects "filly" (in exclusion list)', () => {
        assert.strictEqual(findWakeWord(['filly', 'horse']), -1);
    });

    test('returns -1 when no match found', () => {
        assert.strictEqual(findWakeWord(['hello', 'world']), -1);
    });

    test('case insensitive: uppercase QUILLY matches', () => {
        // tokenize lowercases, so tokens should already be lowercase
        // but test that finding 'quilly' (already lowercased) works
        const idx = findWakeWord(['QUILLY'.toLowerCase()]);
        assert.strictEqual(idx, 0);
    });

    test('matches hardcoded alias "quillie"', () => {
        assert.strictEqual(findWakeWord(['quillie', 'translate']), 0);
    });

    test('matches hardcoded alias "keely"', () => {
        assert.strictEqual(findWakeWord(['keely', 'translate']), 0);
    });
});

// ─── splitContentFromInstruction ──────────────────────────────────────────────

describe('splitContentFromInstruction', () => {
    test('instruction-first: wake word at start, intent keyword follows', () => {
        // "Quilly translate to French the meeting notes"
        // tokens: ['quilly', 'translate', 'to', 'french', 'the', 'meeting', 'notes']
        // wakeIdx=0, intentIdx=1 -> instruction span 0..1 (or up to some end), content = rest
        const tokens = ['quilly', 'translate', 'to', 'french', 'the', 'meeting', 'notes'];
        const wakeIdx = 0;
        const intentIdx = 1;
        // instructionEndIdx: intent keyword token index (at minimum)
        const result = splitContentFromInstruction(tokens, wakeIdx, intentIdx, intentIdx);
        // instruction should include 'quilly translate'
        assert.ok(result.instruction.includes('quilly'), `instruction missing 'quilly': ${result.instruction}`);
        assert.ok(result.instruction.includes('translate'), `instruction missing 'translate': ${result.instruction}`);
        // content should be everything after the instruction span
        assert.ok(result.content.includes('the'), `content missing 'the': ${result.content}`);
        assert.ok(result.content.includes('meeting'), `content missing 'meeting': ${result.content}`);
        assert.ok(result.content.includes('notes'), `content missing 'notes': ${result.content}`);
    });

    test('content-first: content before wake word and intent', () => {
        // "The meeting notes Quilly translate to French"
        // tokens: ['the', 'meeting', 'notes', 'quilly', 'translate', 'to', 'french']
        // wakeIdx=3, intentIdx=4
        const tokens = ['the', 'meeting', 'notes', 'quilly', 'translate', 'to', 'french'];
        const wakeIdx = 3;
        const intentIdx = 4;
        const result = splitContentFromInstruction(tokens, wakeIdx, intentIdx, intentIdx);
        // content = tokens before instruction span (0..2)
        assert.ok(result.content.includes('the'), `content missing 'the': ${result.content}`);
        assert.ok(result.content.includes('meeting'), `content missing 'meeting': ${result.content}`);
        assert.ok(result.content.includes('notes'), `content missing 'notes': ${result.content}`);
        // instruction includes quilly and translate
        assert.ok(result.instruction.includes('quilly'), `instruction missing 'quilly': ${result.instruction}`);
        assert.ok(result.instruction.includes('translate'), `instruction missing 'translate': ${result.instruction}`);
    });

    test('mid-sentence: content stitches both sides of instruction span', () => {
        // "Notes from today Quilly translate to French important stuff"
        // tokens: ['notes', 'from', 'today', 'quilly', 'translate', 'to', 'french', 'important', 'stuff']
        // wakeIdx=3, intentIdx=4
        const tokens = ['notes', 'from', 'today', 'quilly', 'translate', 'to', 'french', 'important', 'stuff'];
        const wakeIdx = 3;
        const intentIdx = 4;
        const result = splitContentFromInstruction(tokens, wakeIdx, intentIdx, intentIdx);
        // content should stitch: "notes from today" + "important stuff"
        assert.ok(result.content.includes('notes'), `content missing 'notes': ${result.content}`);
        assert.ok(result.content.includes('from'), `content missing 'from': ${result.content}`);
        assert.ok(result.content.includes('today'), `content missing 'today': ${result.content}`);
        assert.ok(result.content.includes('important'), `content missing 'important': ${result.content}`);
        assert.ok(result.content.includes('stuff'), `content missing 'stuff': ${result.content}`);
    });

    test('no intent keyword (intentIdx=-1): all non-wake-word tokens as content', () => {
        // tokens: ['hello', 'quilly', 'world']
        // wakeIdx=1, intentIdx=-1
        const tokens = ['hello', 'quilly', 'world'];
        const wakeIdx = 1;
        const intentIdx = -1;
        const result = splitContentFromInstruction(tokens, wakeIdx, intentIdx, intentIdx);
        // content = all tokens except the wake word
        assert.ok(result.content.includes('hello'), `content missing 'hello': ${result.content}`);
        assert.ok(result.content.includes('world'), `content missing 'world': ${result.content}`);
        // instruction is just the wake word
        assert.ok(result.instruction.includes('quilly'), `instruction missing 'quilly': ${result.instruction}`);
        assert.strictEqual(result.instruction.trim(), 'quilly');
    });

    test('wake word only: content is empty string, instruction is wake word', () => {
        // tokens: ['quilly']
        // wakeIdx=0, intentIdx=-1
        const tokens = ['quilly'];
        const wakeIdx = 0;
        const intentIdx = -1;
        const result = splitContentFromInstruction(tokens, wakeIdx, intentIdx, intentIdx);
        assert.strictEqual(result.content.trim(), '');
        assert.ok(result.instruction.includes('quilly'), `instruction missing 'quilly': ${result.instruction}`);
    });
});

// ─── findIntentKeyword ────────────────────────────────────────────────────────

describe('findIntentKeyword', () => {
    test('English: "translate" token returns { intent: "translate", keywordIdx: N }', () => {
        // tokens: ['quilly', 'translate', 'to', 'french']
        // startIdx=0 (from wake word)
        const tokens = ['quilly', 'translate', 'to', 'french'];
        const result = findIntentKeyword(tokens, 0);
        assert.strictEqual(result.intent, 'translate');
        assert.strictEqual(result.keywordIdx, 1);
    });

    test('English: "formal" token returns intent "formal"', () => {
        const tokens = ['quilly', 'make', 'this', 'formal'];
        const result = findIntentKeyword(tokens, 0);
        assert.strictEqual(result.intent, 'formal');
    });

    test('English: "rewrite" token returns intent "rewrite"', () => {
        const tokens = ['quilly', 'rewrite', 'this'];
        const result = findIntentKeyword(tokens, 0);
        assert.strictEqual(result.intent, 'rewrite');
    });

    test('English: "analyze" token returns intent "analyze"', () => {
        const tokens = ['quilly', 'analyze', 'this'];
        const result = findIntentKeyword(tokens, 0);
        assert.strictEqual(result.intent, 'analyze');
    });

    test('English: "summarize" maps to intent "analyze" (synonym)', () => {
        const tokens = ['quilly', 'summarize', 'this'];
        const result = findIntentKeyword(tokens, 0);
        assert.strictEqual(result.intent, 'analyze');
    });

    test('Spanish: "traduce" maps to intent "translate"', () => {
        const tokens = ['quilly', 'traduce', 'al', 'español'];
        const result = findIntentKeyword(tokens, 0);
        assert.strictEqual(result.intent, 'translate');
    });

    test('French: "traduire" maps to intent "translate"', () => {
        const tokens = ['quilly', 'traduire', 'en', 'français'];
        const result = findIntentKeyword(tokens, 0);
        assert.strictEqual(result.intent, 'translate');
    });

    test('German: "übersetzen" maps to intent "translate"', () => {
        const tokens = tokenize('Quilly übersetzen auf Deutsch');
        const wakeIdx = findWakeWord(tokens);
        const result = findIntentKeyword(tokens, wakeIdx);
        assert.strictEqual(result.intent, 'translate');
    });

    test('German: "formell" maps to intent "formal"', () => {
        const tokens = tokenize('Quilly formell bitte');
        const wakeIdx = findWakeWord(tokens);
        const result = findIntentKeyword(tokens, wakeIdx);
        assert.strictEqual(result.intent, 'formal');
    });

    test('No keyword match returns { intent: null, keywordIdx: -1 }', () => {
        const tokens = ['quilly', 'hello', 'there'];
        const result = findIntentKeyword(tokens, 0);
        assert.strictEqual(result.intent, null);
        assert.strictEqual(result.keywordIdx, -1);
    });

    test('Returns first matching intent when both "translate" and "formal" appear', () => {
        // "translate" appears before "formal" — should return "translate"
        const tokens = ['quilly', 'translate', 'formal', 'this'];
        const result = findIntentKeyword(tokens, 0);
        assert.strictEqual(result.intent, 'translate');
        assert.strictEqual(result.keywordIdx, 1);
    });

    test('Returns first matching intent when "formal" appears before "translate"', () => {
        // "formal" appears before "translate" — should return "formal"
        const tokens = ['quilly', 'formal', 'translate', 'this'];
        const result = findIntentKeyword(tokens, 0);
        assert.strictEqual(result.intent, 'formal');
        assert.strictEqual(result.keywordIdx, 1);
    });

    test('Fallback scan: intent keyword before wake word is found via fallback', () => {
        // "translate" comes before the wake word "quilly" — fallback scan should find it
        const tokens = ['translate', 'this', 'quilly'];
        const wakeIdx = findWakeWord(tokens); // wakeIdx = 2
        const result = findIntentKeyword(tokens, wakeIdx);
        assert.strictEqual(result.intent, 'translate');
        assert.strictEqual(result.keywordIdx, 0);
    });
});

// ─── extractLanguage ──────────────────────────────────────────────────────────

describe('extractLanguage', () => {
    test('"to French" → "French"', () => {
        const tokens = ['translate', 'to', 'french'];
        // afterIdx=0 (after "translate")
        const result = extractLanguage(tokens, 0, null);
        assert.strictEqual(result.language, 'French');
    });

    test('"en español" → "Spanish"', () => {
        const tokens = ['traduce', 'en', 'español'];
        const result = extractLanguage(tokens, 0, null);
        assert.strictEqual(result.language, 'Spanish');
    });

    test('"auf Deutsch" → "German"', () => {
        const tokens = tokenize('übersetzen auf Deutsch');
        const result = extractLanguage(tokens, 0, null);
        assert.strictEqual(result.language, 'German');
    });

    test('"en japonés" → "Japanese"', () => {
        const tokens = ['translate', 'en', 'japonés'];
        const result = extractLanguage(tokens, 0, null);
        assert.strictEqual(result.language, 'Japanese');
    });

    test('Native name "français" (without preposition) → "French"', () => {
        const tokens = ['translate', 'français'];
        const result = extractLanguage(tokens, 0, null);
        assert.strictEqual(result.language, 'French');
    });

    test('"to english" → "English"', () => {
        const tokens = ['translate', 'to', 'english'];
        const result = extractLanguage(tokens, 0, null);
        assert.strictEqual(result.language, 'English');
    });

    test('Unknown language "to Klingon" → falls back to defaultLanguage', () => {
        const tokens = ['translate', 'to', 'klingon'];
        const result = extractLanguage(tokens, 0, 'Spanish');
        assert.strictEqual(result.language, 'Spanish');
    });

    test('Unknown language with null defaultLanguage → null', () => {
        const tokens = ['translate', 'to', 'klingon'];
        const result = extractLanguage(tokens, 0, null);
        assert.strictEqual(result.language, null);
    });

    test('No language tokens after intent keyword → null (with null default)', () => {
        const tokens = ['translate'];
        const result = extractLanguage(tokens, 0, null);
        assert.strictEqual(result.language, null);
    });

    test('Case insensitive: "TO FRENCH" → "French"', () => {
        const tokens = ['translate', 'to', 'french']; // already lowercased by tokenize
        const result = extractLanguage(tokens, 0, null);
        assert.strictEqual(result.language, 'French');
    });

    test('"into French" → "French" (multi-word preposition handling)', () => {
        const tokens = ['translate', 'into', 'french'];
        const result = extractLanguage(tokens, 0, null);
        assert.strictEqual(result.language, 'French');
    });

    test('"this to french" after translate keyword -> "French"', () => {
        // tokens: ['translate', 'this', 'to', 'french'], afterIdx=0
        // content token "this" sits between keyword and language spec
        const tokens = ['translate', 'this', 'to', 'french'];
        const result = extractLanguage(tokens, 0, null);
        assert.strictEqual(result.language, 'French');
        assert.strictEqual(result.tokensConsumed, 3);
    });

    test('"hello to spanish" after translate keyword -> "Spanish"', () => {
        // tokens: ['translate', 'hello', 'to', 'spanish'], afterIdx=0
        const tokens = ['translate', 'hello', 'to', 'spanish'];
        const result = extractLanguage(tokens, 0, null);
        assert.strictEqual(result.language, 'Spanish');
        assert.strictEqual(result.tokensConsumed, 3);
    });

    test('"this to français" after translate keyword -> "French" (endonym)', () => {
        // tokens: ['translate', 'this', 'to', 'français'], afterIdx=0
        const tokens = ['translate', 'this', 'to', 'français'];
        const result = extractLanguage(tokens, 0, null);
        assert.strictEqual(result.language, 'French');
        assert.strictEqual(result.tokensConsumed, 3);
    });

    test('multiple content tokens: "please make this into french" -> "French"', () => {
        // tokens: ['translate', 'please', 'make', 'this', 'into', 'french'], afterIdx=0
        const tokens = ['translate', 'please', 'make', 'this', 'into', 'french'];
        const result = extractLanguage(tokens, 0, null);
        assert.strictEqual(result.language, 'French');
        assert.strictEqual(result.tokensConsumed, 5);
    });

    test('no language anywhere falls back to defaultLanguage', () => {
        // tokens: ['translate', 'this', 'thing', 'now'], afterIdx=0, defaultLanguage='German'
        // full scan finds no language -> returns defaultLanguage with tokensConsumed=0
        const tokens = ['translate', 'this', 'thing', 'now'];
        const result = extractLanguage(tokens, 0, 'German');
        assert.strictEqual(result.language, 'German');
        assert.strictEqual(result.tokensConsumed, 0);
    });

    test('adjacent pattern still works: "to french" directly after keyword', () => {
        // Regression guard: this already-working pattern must not break
        // tokens: ['translate', 'to', 'french'], afterIdx=0
        const tokens = ['translate', 'to', 'french'];
        const result = extractLanguage(tokens, 0, null);
        assert.strictEqual(result.language, 'French');
        assert.strictEqual(result.tokensConsumed, 2);
    });
});

// ─── route — full integration ─────────────────────────────────────────────────

describe('route — full integration', () => {
    test('No wake word: returns wakeWordFound false, intent null, targetLanguage null', () => {
        const result = route('Translate this to French', null);
        assert.strictEqual(result.wakeWordFound, false);
        assert.strictEqual(result.intent, null);
        assert.strictEqual(result.targetLanguage, null);
        assert.ok(result.content.length > 0, 'content should be the original text');
        assert.strictEqual(result.rawInstruction, '');
    });

    test('Wake word + translate: extracts intent and target language', () => {
        const result = route('Quilly, translate to French. The meeting notes from today', null);
        assert.strictEqual(result.wakeWordFound, true);
        assert.strictEqual(result.intent, 'translate');
        assert.strictEqual(result.targetLanguage, 'French');
        assert.ok(result.content.toLowerCase().includes('meeting'), `content should include 'meeting': ${result.content}`);
        assert.ok(result.rawInstruction.toLowerCase().includes('translate'), `rawInstruction should include 'translate': ${result.rawInstruction}`);
    });

    test('Content-first: "The meeting notes from today. Quilly, translate to French" → same intent and language', () => {
        const result = route('The meeting notes from today. Quilly, translate to French', null);
        assert.strictEqual(result.wakeWordFound, true);
        assert.strictEqual(result.intent, 'translate');
        assert.strictEqual(result.targetLanguage, 'French');
        assert.ok(result.content.toLowerCase().includes('meeting'), `content should include 'meeting': ${result.content}`);
    });

    test('Wake word + formal: returns intent "formal", targetLanguage null', () => {
        const result = route('Quilly, make this formal. Dear sir', null);
        assert.strictEqual(result.wakeWordFound, true);
        assert.strictEqual(result.intent, 'formal');
        assert.strictEqual(result.targetLanguage, null);
        assert.ok(result.content.toLowerCase().includes('dear'), `content should include 'dear': ${result.content}`);
    });

    test('Wake word + rewrite: returns intent "rewrite"', () => {
        const result = route('Quilly rewrite this. The quick brown fox', null);
        assert.strictEqual(result.wakeWordFound, true);
        assert.strictEqual(result.intent, 'rewrite');
        assert.ok(result.content.toLowerCase().includes('quick'), `content should include 'quick': ${result.content}`);
    });

    test('Wake word + analyze: returns intent "analyze"', () => {
        const result = route('Quilly analyze this. Some data here', null);
        assert.strictEqual(result.wakeWordFound, true);
        assert.strictEqual(result.intent, 'analyze');
        assert.ok(result.content.toLowerCase().includes('data'), `content should include 'data': ${result.content}`);
    });

    test('Wake word but no intent keyword: returns wakeWordFound true, intent freeform', () => {
        const result = route('Quilly, hello there', null);
        assert.strictEqual(result.wakeWordFound, true);
        assert.strictEqual(result.intent, 'freeform');
        assert.strictEqual(result.targetLanguage, null);
        assert.ok(result.content.toLowerCase().includes('hello'), `content should include 'hello': ${result.content}`);
    });

    test('Translate with defaultLanguage fallback: no language in speech → uses defaultLanguage', () => {
        const result = route('Quilly translate this. My content', 'Spanish');
        assert.strictEqual(result.wakeWordFound, true);
        assert.strictEqual(result.intent, 'translate');
        assert.strictEqual(result.targetLanguage, 'Spanish');
        assert.ok(result.content.toLowerCase().includes('content'), `content should include 'content': ${result.content}`);
    });

    test('Multilingual keyword: "traduce al español" → intent translate, targetLanguage Spanish', () => {
        const result = route('Quilly, traduce al español. Mis notas', null);
        assert.strictEqual(result.wakeWordFound, true);
        assert.strictEqual(result.intent, 'translate');
        assert.strictEqual(result.targetLanguage, 'Spanish');
        assert.ok(result.content.toLowerCase().includes('mis') || result.content.toLowerCase().includes('notas'),
            `content should include the spanish content: ${result.content}`);
    });

    test('Mid-sentence wake word: content stitches both sides', () => {
        const result = route('Notes from today Quilly translate to German important stuff', null);
        assert.strictEqual(result.wakeWordFound, true);
        assert.strictEqual(result.intent, 'translate');
        assert.strictEqual(result.targetLanguage, 'German');
        // content should contain tokens from both sides
        const contentLower = result.content.toLowerCase();
        assert.ok(contentLower.includes('notes'), `content should include 'notes': ${result.content}`);
        assert.ok(contentLower.includes('important') || contentLower.includes('stuff'),
            `content should include tokens from after the instruction: ${result.content}`);
    });

    test('Non-translate intent returns targetLanguage null (not undefined)', () => {
        const result = route('Quilly formalize this please', null);
        assert.strictEqual(result.wakeWordFound, true);
        // intent should be 'formal' (formalize is in the formal keywords)
        assert.notStrictEqual(result.intent, 'translate');
        // targetLanguage must be explicitly null, not undefined
        assert.strictEqual(result.targetLanguage, null);
    });

    test('route() returns complete RouteResult shape for all paths', () => {
        const result = route('Quilly, translate to French. Hello', null);
        assert.ok('wakeWordFound' in result, 'must have wakeWordFound');
        assert.ok('intent' in result, 'must have intent');
        assert.ok('targetLanguage' in result, 'must have targetLanguage');
        assert.ok('content' in result, 'must have content');
        assert.ok('rawInstruction' in result, 'must have rawInstruction');
    });

    test('translate with content between keyword and language: "Quilly translate this to French"', () => {
        const result = route('Quilly translate this to French');
        assert.strictEqual(result.wakeWordFound, true);
        assert.strictEqual(result.intent, 'translate');
        assert.strictEqual(result.targetLanguage, 'French');
        assert.strictEqual(result.content, 'this');
    });

    test('fuzzy wake + content between keyword and language: "quilley translate hello to Spanish"', () => {
        const result = route('quilley translate hello to Spanish');
        assert.strictEqual(result.wakeWordFound, true);
        assert.strictEqual(result.intent, 'translate');
        assert.strictEqual(result.targetLanguage, 'Spanish');
        assert.strictEqual(result.content, 'hello');
    });

    test('endonym with content between: "Quilly translate this to français"', () => {
        const result = route('Quilly translate this to français');
        assert.strictEqual(result.wakeWordFound, true);
        assert.strictEqual(result.intent, 'translate');
        assert.strictEqual(result.targetLanguage, 'French');
        assert.strictEqual(result.content, 'this');
    });
});

// ─── grammar and concise intent classification ────────────────────────────────

describe('grammar and concise intent classification', () => {
    test('grammar keyword: "Quilly fix the grammar in this sentence" → intent grammar', () => {
        const result = route('Quilly fix the grammar in this sentence');
        assert.strictEqual(result.wakeWordFound, true);
        assert.strictEqual(result.intent, 'grammar');
    });

    test('grammar keyword proofread: "Quilly proofread this text" → intent grammar', () => {
        const result = route('Quilly proofread this text');
        assert.strictEqual(result.wakeWordFound, true);
        assert.strictEqual(result.intent, 'grammar');
    });

    test('concise keyword: "Quilly make this concise" → intent concise', () => {
        const result = route('Quilly make this concise');
        assert.strictEqual(result.wakeWordFound, true);
        assert.strictEqual(result.intent, 'concise');
    });

    test('concise keyword shorten: "Quilly shorten this paragraph" → intent concise', () => {
        const result = route('Quilly shorten this paragraph');
        assert.strictEqual(result.wakeWordFound, true);
        assert.strictEqual(result.intent, 'concise');
    });

    test('grammar before rewrite: "Quilly fix my writing" → intent grammar (not rewrite)', () => {
        const result = route('Quilly fix my writing');
        assert.strictEqual(result.wakeWordFound, true);
        assert.strictEqual(result.intent, 'grammar');
        assert.notStrictEqual(result.intent, 'rewrite',
            '"fix" should match grammar before rewrite (first-match wins)'
        );
    });
});

// ─── professional/email/report intent routing ─────────────────────────────────

describe('professional, email, report intent routing', () => {
    test('"Quilly professional this" → intent professional', () => {
        const result = route('Quilly professional this');
        assert.strictEqual(result.wakeWordFound, true);
        assert.strictEqual(result.intent, 'professional');
    });

    test('"Quilly professionalize this" → intent professional', () => {
        const result = route('Quilly professionalize this');
        assert.strictEqual(result.wakeWordFound, true);
        assert.strictEqual(result.intent, 'professional');
    });

    test('"Quilly email this" → intent email', () => {
        const result = route('Quilly email this');
        assert.strictEqual(result.wakeWordFound, true);
        assert.strictEqual(result.intent, 'email');
    });

    test('"Quilly e-mail this" → intent email', () => {
        const result = route('Quilly e-mail this');
        assert.strictEqual(result.wakeWordFound, true);
        assert.strictEqual(result.intent, 'email');
    });

    test('"Quilly report this" → intent report', () => {
        const result = route('Quilly report this');
        assert.strictEqual(result.wakeWordFound, true);
        assert.strictEqual(result.intent, 'report');
    });

    test('"Quilly memo this" → intent report', () => {
        const result = route('Quilly memo this');
        assert.strictEqual(result.wakeWordFound, true);
        assert.strictEqual(result.intent, 'report');
    });

    test('German keyword: "Quilly professionell dies" → intent professional', () => {
        const result = route('Quilly professionell dies');
        assert.strictEqual(result.wakeWordFound, true);
        assert.strictEqual(result.intent, 'professional');
    });

    test('negative: "Quilly formal this" still returns intent formal (not hijacked by professional)', () => {
        const result = route('Quilly formal this');
        assert.strictEqual(result.wakeWordFound, true);
        assert.strictEqual(result.intent, 'formal');
        assert.notStrictEqual(result.intent, 'professional',
            '"formal" keyword must route to formal, not professional (first-match semantics)'
        );
    });
});
