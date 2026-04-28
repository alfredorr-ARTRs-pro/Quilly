'use strict';

// Tests for electron/promptTemplates.cjs
// Uses Node.js built-in test runner: node --test electron/promptTemplates.test.cjs
//
// These tests validate the PROMPT_TEMPLATES data module:
//   - All 9 intent keys present
//   - Correct temperatures per intent
//   - Correct types (function vs string) for systemPrompts
//   - translate factory produces language-specific strings
//   - Tone prompts are distinct (no two are equal)
//   - grammar and rewrite are distinct (different intent, different prompt)

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { PROMPT_TEMPLATES } = require('./promptTemplates.cjs');

const EXPECTED_INTENTS = [
    'translate', 'formal', 'professional', 'email', 'report',
    'concise', 'grammar', 'rewrite', 'analyze', 'freeform',
];

// ─── Structure tests ──────────────────────────────────────────────────────────

describe('PROMPT_TEMPLATES structure', () => {
    test('has all 9 required intent keys', () => {
        for (const intent of EXPECTED_INTENTS) {
            assert.ok(intent in PROMPT_TEMPLATES, `Missing intent key: ${intent}`);
        }
    });

    test('has no extra unexpected keys', () => {
        const actualKeys = Object.keys(PROMPT_TEMPLATES).sort();
        const expectedKeys = [...EXPECTED_INTENTS].sort();
        assert.deepStrictEqual(actualKeys, expectedKeys);
    });

    test('each entry has a systemPrompt property', () => {
        for (const intent of EXPECTED_INTENTS) {
            const entry = PROMPT_TEMPLATES[intent];
            assert.ok('systemPrompt' in entry, `Missing systemPrompt in intent: ${intent}`);
        }
    });

    test('each entry has a temperature property', () => {
        for (const intent of EXPECTED_INTENTS) {
            const entry = PROMPT_TEMPLATES[intent];
            assert.ok('temperature' in entry, `Missing temperature in intent: ${intent}`);
        }
    });
});

// ─── Temperature tests ────────────────────────────────────────────────────────

describe('PROMPT_TEMPLATES temperatures', () => {
    test('translate has temperature 0.3', () => {
        assert.strictEqual(PROMPT_TEMPLATES.translate.temperature, 0.3);
    });

    test('formal has temperature 0.4', () => {
        assert.strictEqual(PROMPT_TEMPLATES.formal.temperature, 0.4);
    });

    test('professional has temperature 0.4', () => {
        assert.strictEqual(PROMPT_TEMPLATES.professional.temperature, 0.4);
    });

    test('report has temperature 0.4', () => {
        assert.strictEqual(PROMPT_TEMPLATES.report.temperature, 0.4);
    });

    test('concise has temperature 0.4', () => {
        assert.strictEqual(PROMPT_TEMPLATES.concise.temperature, 0.4);
    });

    test('email has temperature 0.5', () => {
        assert.strictEqual(PROMPT_TEMPLATES.email.temperature, 0.5);
    });

    test('rewrite has temperature 0.5', () => {
        assert.strictEqual(PROMPT_TEMPLATES.rewrite.temperature, 0.5);
    });

    test('analyze has temperature 0.6', () => {
        assert.strictEqual(PROMPT_TEMPLATES.analyze.temperature, 0.6);
    });

    test('grammar has temperature 0.3', () => {
        assert.strictEqual(PROMPT_TEMPLATES.grammar.temperature, 0.3);
    });
});

// ─── System prompt type tests ─────────────────────────────────────────────────

describe('PROMPT_TEMPLATES systemPrompt types', () => {
    test('translate.systemPrompt is a function (factory)', () => {
        assert.strictEqual(typeof PROMPT_TEMPLATES.translate.systemPrompt, 'function');
    });

    test('formal.systemPrompt is a non-empty string', () => {
        const sp = PROMPT_TEMPLATES.formal.systemPrompt;
        assert.strictEqual(typeof sp, 'string');
        assert.ok(sp.length > 0, 'formal systemPrompt must not be empty');
    });

    test('professional.systemPrompt is a non-empty string', () => {
        const sp = PROMPT_TEMPLATES.professional.systemPrompt;
        assert.strictEqual(typeof sp, 'string');
        assert.ok(sp.length > 0, 'professional systemPrompt must not be empty');
    });

    test('email.systemPrompt is a non-empty string', () => {
        const sp = PROMPT_TEMPLATES.email.systemPrompt;
        assert.strictEqual(typeof sp, 'string');
        assert.ok(sp.length > 0, 'email systemPrompt must not be empty');
    });

    test('report.systemPrompt is a non-empty string', () => {
        const sp = PROMPT_TEMPLATES.report.systemPrompt;
        assert.strictEqual(typeof sp, 'string');
        assert.ok(sp.length > 0, 'report systemPrompt must not be empty');
    });

    test('concise.systemPrompt is a non-empty string', () => {
        const sp = PROMPT_TEMPLATES.concise.systemPrompt;
        assert.strictEqual(typeof sp, 'string');
        assert.ok(sp.length > 0, 'concise systemPrompt must not be empty');
    });

    test('grammar.systemPrompt is a non-empty string', () => {
        const sp = PROMPT_TEMPLATES.grammar.systemPrompt;
        assert.strictEqual(typeof sp, 'string');
        assert.ok(sp.length > 0, 'grammar systemPrompt must not be empty');
    });

    test('rewrite.systemPrompt is a non-empty string', () => {
        const sp = PROMPT_TEMPLATES.rewrite.systemPrompt;
        assert.strictEqual(typeof sp, 'string');
        assert.ok(sp.length > 0, 'rewrite systemPrompt must not be empty');
    });

    test('analyze.systemPrompt is a non-empty string', () => {
        const sp = PROMPT_TEMPLATES.analyze.systemPrompt;
        assert.strictEqual(typeof sp, 'string');
        assert.ok(sp.length > 0, 'analyze systemPrompt must not be empty');
    });
});

// ─── Factory test ─────────────────────────────────────────────────────────────

describe('PROMPT_TEMPLATES translate factory', () => {
    test('translate.systemPrompt("French") returns a string containing "French"', () => {
        const result = PROMPT_TEMPLATES.translate.systemPrompt('French');
        assert.strictEqual(typeof result, 'string');
        assert.ok(result.includes('French'), `Expected result to include "French", got: ${result}`);
    });

    test('translate.systemPrompt("Japanese") returns a string containing "Japanese"', () => {
        const result = PROMPT_TEMPLATES.translate.systemPrompt('Japanese');
        assert.strictEqual(typeof result, 'string');
        assert.ok(result.includes('Japanese'), `Expected result to include "Japanese", got: ${result}`);
    });

    test('translate.systemPrompt("Spanish") returns a string containing "Spanish"', () => {
        const result = PROMPT_TEMPLATES.translate.systemPrompt('Spanish');
        assert.strictEqual(typeof result, 'string');
        assert.ok(result.includes('Spanish'), `Expected result to include "Spanish", got: ${result}`);
    });
});

// ─── Distinctness tests ───────────────────────────────────────────────────────

describe('PROMPT_TEMPLATES tone distinctness', () => {
    test('formal and professional have different systemPrompts', () => {
        assert.notStrictEqual(
            PROMPT_TEMPLATES.formal.systemPrompt,
            PROMPT_TEMPLATES.professional.systemPrompt,
            'formal and professional must have distinct prompts'
        );
    });

    test('formal and email have different systemPrompts', () => {
        assert.notStrictEqual(
            PROMPT_TEMPLATES.formal.systemPrompt,
            PROMPT_TEMPLATES.email.systemPrompt,
            'formal and email must have distinct prompts'
        );
    });

    test('formal and report have different systemPrompts', () => {
        assert.notStrictEqual(
            PROMPT_TEMPLATES.formal.systemPrompt,
            PROMPT_TEMPLATES.report.systemPrompt,
            'formal and report must have distinct prompts'
        );
    });

    test('formal and concise have different systemPrompts', () => {
        assert.notStrictEqual(
            PROMPT_TEMPLATES.formal.systemPrompt,
            PROMPT_TEMPLATES.concise.systemPrompt,
            'formal and concise must have distinct prompts'
        );
    });

    test('professional and email have different systemPrompts', () => {
        assert.notStrictEqual(
            PROMPT_TEMPLATES.professional.systemPrompt,
            PROMPT_TEMPLATES.email.systemPrompt,
            'professional and email must have distinct prompts'
        );
    });

    test('professional and report have different systemPrompts', () => {
        assert.notStrictEqual(
            PROMPT_TEMPLATES.professional.systemPrompt,
            PROMPT_TEMPLATES.report.systemPrompt,
            'professional and report must have distinct prompts'
        );
    });

    test('professional and concise have different systemPrompts', () => {
        assert.notStrictEqual(
            PROMPT_TEMPLATES.professional.systemPrompt,
            PROMPT_TEMPLATES.concise.systemPrompt,
            'professional and concise must have distinct prompts'
        );
    });

    test('email and report have different systemPrompts', () => {
        assert.notStrictEqual(
            PROMPT_TEMPLATES.email.systemPrompt,
            PROMPT_TEMPLATES.report.systemPrompt,
            'email and report must have distinct prompts'
        );
    });

    test('email and concise have different systemPrompts', () => {
        assert.notStrictEqual(
            PROMPT_TEMPLATES.email.systemPrompt,
            PROMPT_TEMPLATES.concise.systemPrompt,
            'email and concise must have distinct prompts'
        );
    });

    test('report and concise have different systemPrompts', () => {
        assert.notStrictEqual(
            PROMPT_TEMPLATES.report.systemPrompt,
            PROMPT_TEMPLATES.concise.systemPrompt,
            'report and concise must have distinct prompts'
        );
    });
});

// ─── Grammar vs rewrite distinctness ─────────────────────────────────────────

describe('PROMPT_TEMPLATES grammar vs rewrite', () => {
    test('grammar and rewrite have different systemPrompts', () => {
        assert.notStrictEqual(
            PROMPT_TEMPLATES.grammar.systemPrompt,
            PROMPT_TEMPLATES.rewrite.systemPrompt,
            'grammar and rewrite must have distinct prompts (grammar preserves tone, rewrite changes it)'
        );
    });

    test('grammar systemPrompt indicates minimal-change or preservation intent', () => {
        const sp = PROMPT_TEMPLATES.grammar.systemPrompt.toLowerCase();
        const preservesOriginal = sp.includes('preserv') || sp.includes('minimal') || sp.includes('only');
        assert.ok(preservesOriginal,
            `grammar prompt must indicate minimal changes/preservation of original. Got: ${PROMPT_TEMPLATES.grammar.systemPrompt}`
        );
    });
});
