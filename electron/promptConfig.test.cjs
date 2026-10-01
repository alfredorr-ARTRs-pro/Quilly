'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const promptConfig = require('./promptConfig.cjs');

const createStore = (initial = {}) => {
    const data = { ...initial };
    return {
        get(key, fallback) {
            return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback;
        },
        set(key, value) {
            data[key] = value;
        },
        data,
    };
};

describe('FINAL_CLEANUP_MODEL_OPTIONS', () => {
    test('includes the supported auto / 4B / 9B options', () => {
        const ids = promptConfig.FINAL_CLEANUP_MODEL_OPTIONS.map(o => o.id);
        for (const expected of ['auto', 'qwen3.5-4b', 'qwen3.5-9b']) {
            assert.ok(ids.includes(expected), `Missing option: ${expected}`);
        }
    });

    test('does not include retired helper or balanced models', () => {
        const ids = promptConfig.FINAL_CLEANUP_MODEL_OPTIONS.map(o => o.id);
        assert.ok(!ids.includes('qwen3.5-0.8b-live'));
        assert.ok(!ids.includes('qwen3-8b'));
    });

    test('every option has a stable shape (id, label, description)', () => {
        for (const opt of promptConfig.FINAL_CLEANUP_MODEL_OPTIONS) {
            assert.equal(typeof opt.id, 'string');
            assert.ok(opt.id.length > 0);
            assert.equal(typeof opt.label, 'string');
            assert.ok(opt.label.length > 0);
            assert.equal(typeof opt.description, 'string');
            assert.ok(opt.description.length > 0);
        }
    });

    test('default cleanup model from createInstalledProfile is still installable', () => {
        const installed = promptConfig.createInstalledProfile();
        const validIds = new Set(promptConfig.FINAL_CLEANUP_MODEL_OPTIONS.map(o => o.id));
        assert.ok(validIds.has(installed.finalCleanup.modelId));
    });
});

describe('promptConfig.shouldSkipFinalCleanup', () => {
    test('skips empty or whitespace-only input', () => {
        assert.equal(promptConfig.shouldSkipFinalCleanup(''), true);
        assert.equal(promptConfig.shouldSkipFinalCleanup('   \n  '), true);
        assert.equal(promptConfig.shouldSkipFinalCleanup(null), true);
    });

    test('skips short well-formed input ending in terminal punctuation', () => {
        assert.equal(promptConfig.shouldSkipFinalCleanup('Send the report to John.'), true);
        assert.equal(promptConfig.shouldSkipFinalCleanup('Are we still on for Friday?'), true);
        assert.equal(promptConfig.shouldSkipFinalCleanup('That works!'), true);
        assert.equal(promptConfig.shouldSkipFinalCleanup('"All good."'), true);
    });

    test('does not skip short input without terminal punctuation', () => {
        assert.equal(promptConfig.shouldSkipFinalCleanup('send the report to john'), false);
        assert.equal(promptConfig.shouldSkipFinalCleanup('quick note'), false);
    });

    test('does not skip long input even if well-formed', () => {
        const long = 'This is a long sentence. '.repeat(20).trim();
        assert.ok(long.length >= promptConfig.SHORT_CLEANUP_LENGTH_LIMIT);
        assert.equal(promptConfig.shouldSkipFinalCleanup(long), false);
    });
});

describe('DEFAULT_FINAL_CLEANUP_PROMPT', () => {
    test('contains anti-rewrite anchor', () => {
        const prompt = promptConfig.DEFAULT_FINAL_CLEANUP_PROMPT;
        assert.ok(/Stay close to the original wording/i.test(prompt));
        assert.ok(/Do not paraphrase/i.test(prompt));
        assert.ok(/return rawText unchanged/i.test(prompt));
    });

    test('contains a near-identity example showing minimal edits', () => {
        const prompt = promptConfig.DEFAULT_FINAL_CLEANUP_PROMPT;
        assert.ok(/no changes/i.test(prompt));
        assert.ok(/Example 1/i.test(prompt));
    });

    test('does not include the obsolete plain-text escape clause', () => {
        const prompt = promptConfig.DEFAULT_FINAL_CLEANUP_PROMPT;
        assert.ok(!/Plain cleaned text is also accepted/i.test(prompt));
    });
});

describe('promptConfig developer profiles', () => {
    test('always exposes installed configuration as a locked profile', () => {
        const store = createStore();
        const config = promptConfig.getDeveloperConfigFromStore(store);

        assert.equal(config.activeProfileId, promptConfig.INSTALLED_PROFILE_ID);
        assert.equal(config.profiles[0].id, promptConfig.INSTALLED_PROFILE_ID);
        assert.equal(config.profiles[0].isInstalled, true);
        assert.equal(config.profiles[0].locked, true);
    });

    test('does not persist installed configuration as a custom profile', () => {
        const store = createStore();
        const installed = promptConfig.createInstalledProfile();

        const saved = promptConfig.saveDeveloperConfigToStore(store, {
            enabled: true,
            activeProfileId: promptConfig.INSTALLED_PROFILE_ID,
            profiles: [installed],
        });

        assert.equal(saved.profiles.length, 1);
        assert.equal(store.data.promptProfiles.length, 0);
        assert.equal(saved.activeProfileId, promptConfig.INSTALLED_PROFILE_ID);
    });

    test('saving a modified installed draft creates a custom profile', () => {
        const store = createStore();
        const installedDraft = promptConfig.createInstalledProfile();
        installedDraft.name = 'Doctor Notes';
        installedDraft.finalCleanup.temperature = 0.4;

        const saved = promptConfig.saveDeveloperConfigToStore(store, {
            enabled: true,
            activeProfileId: promptConfig.INSTALLED_PROFILE_ID,
            profiles: [installedDraft],
        });

        assert.equal(saved.profiles.length, 2);
        assert.notEqual(saved.activeProfileId, promptConfig.INSTALLED_PROFILE_ID);
        assert.equal(saved.profiles[0].id, promptConfig.INSTALLED_PROFILE_ID);
        assert.equal(saved.profiles[0].finalCleanup.temperature, 0.1);

        const custom = saved.profiles.find(profile => profile.id === saved.activeProfileId);
        assert.equal(custom.name, 'Doctor Notes');
        assert.equal(custom.isInstalled, false);
        assert.equal(custom.finalCleanup.temperature, 0.4);
        assert.equal(store.data.promptProfiles.length, 1);
    });
});
