'use strict';

const { PROMPT_TEMPLATES } = require('./promptTemplates.cjs');

const PROFILE_SCHEMA_VERSION = 1;
const INSTALLED_PROFILE_ID = 'installed-default';

const INTENT_LABELS = {
    freeform: 'Freeform',
    rewrite: 'Rewrite',
    grammar: 'Grammar',
    concise: 'Concise',
    formal: 'Formal',
    professional: 'Professional',
    email: 'Email',
    report: 'Report',
    analyze: 'Analyze',
    translate: 'Translate',
};

const FINAL_CLEANUP_MODEL_OPTIONS = [
    {
        id: 'auto',
        label: 'Main AI Model - Auto',
        description: 'Uses the best installed main Quilly model.',
    },
    {
        id: 'qwen3.5-4b',
        label: 'Fast Model - 4B',
        description: 'Better cleanup quality if your machine can run it.',
    },
    {
        id: 'qwen3.5-9b',
        label: 'Quality Model - 9B',
        description: 'Highest local cleanup quality, slower and heavier.',
    },
];

const DEFAULT_FINAL_CLEANUP_PROMPT = [
    'You are Quilly, cleaning up a finished dictation transcript.',
    '',
    "Your job is to make rawText easier to read while preserving the speaker's exact meaning, language, names, numbers, dates, and intent. Stay close to the original wording. The cleaned output should be roughly the same length as the input. Do not paraphrase. Do not translate. Do not summarize. Do not add facts. Do not turn the text into an email, list, or report unless the speaker explicitly asked for that format.",
    '',
    'Inputs:',
    '- rawText: the Whisper transcript.',
    '- locallyStructuredDraft (optional): rawText with paragraph breaks already inserted by local rules.',
    '',
    'Apply these edits ONLY when CLEARLY warranted by context:',
    '1. Replace a misheard word with the obviously intended one (e.g. "table" → "cable" when discussing wiring).',
    '2. Remove exact stutters and false starts ("the the", "I— I think").',
    "3. Apply the speaker's own self-correction (\"meet Tuesday, no Friday\" → \"meet Friday\").",
    '4. Fix punctuation and capitalization at sentence boundaries.',
    '5. Insert a paragraph break at clear topic shifts and discourse cues ("anyway", "next point", "another thing").',
    '6. When the speaker enumerates points ("point one… point two…"), put each point on its own line.',
    '',
    'If locallyStructuredDraft is provided, prefer its paragraph layout and only adjust wording inside paragraphs.',
    '',
    'DEFAULT BEHAVIOR: when in doubt, return rawText unchanged. A faithful transcript is better than a polished one. If you are not sure whether to make an edit, do not make it.',
    '',
    'Respond with JSON only:',
    '{"text":"<cleaned transcript>","editSummary":"<≤12 words describing changes, or \'no changes\'>"}',
    '',
    'Example 1 — input that needs almost no changes:',
    'rawText: "I think we should ship the build on Friday. After that we can tag the release."',
    'output: {"text":"I think we should ship the build on Friday. After that we can tag the release.","editSummary":"no changes"}',
    '',
    'Example 2 — input with a self-correction and numbered points:',
    'rawText: "so the the meeting is tuesday no friday lets do friday at three. point number one we ship the build point number two we tag the release"',
    'output: {"text":"So the meeting is Friday — let\'s do Friday at three.\\n\\n1. We ship the build.\\n2. We tag the release.","editSummary":"removed stutter, applied self-correction, numbered points"}',
].join('\n');

const DEFAULT_LOCAL_STRUCTURE_RULES = {
    enabled: true,
    phraseBreaks: true,
    spokenPointBreaks: true,
    standaloneNumberBreaks: true,
    decimalNumberBreaks: true,
    ordinalBreaks: true,
    groupLongParagraphs: true,
    phraseBreakCues: [
        'on another point',
        'another point',
        'the next point',
        'next point',
        'first,',
        'second,',
        'third,',
        'fourth,',
        'fifth,',
        'finally',
        'lastly',
    ],
    numberedPointCues: [
        'point number',
        'point',
        'number',
    ],
    customReplacements: [],
};

const getPromptText = (intent, template) => {
    if (typeof template.systemPrompt === 'function') {
        return template.systemPrompt('{{targetLanguage}}');
    }
    return template.systemPrompt;
};

const createDefaultLlmPromptOverrides = () => {
    const result = {};
    for (const [intent, template] of Object.entries(PROMPT_TEMPLATES)) {
        result[intent] = {
            enabled: false,
            systemPrompt: getPromptText(intent, template),
            temperature: template.temperature,
        };
    }
    return result;
};

const createInstalledProfile = () => ({
    id: INSTALLED_PROFILE_ID,
    name: 'Installed Configuration',
    isInstalled: true,
    locked: true,
    schemaVersion: PROFILE_SCHEMA_VERSION,
    finalCleanup: {
        modelId: 'auto',
        systemPrompt: DEFAULT_FINAL_CLEANUP_PROMPT,
        temperature: 0.1,
        sendLocalStructureDraft: true,
        localStructureRules: { ...DEFAULT_LOCAL_STRUCTURE_RULES },
    },
    llmPrompts: createDefaultLlmPromptOverrides(),
});

const clone = (value) => JSON.parse(JSON.stringify(value));

const createProfileId = () => `profile-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

const createGeneratedProfileName = (profiles = []) => {
    const existing = new Set(
        (Array.isArray(profiles) ? profiles : [])
            .map(profile => String(profile?.name || '').trim().toLowerCase())
            .filter(Boolean)
    );

    for (let attempt = 0; attempt < 20; attempt++) {
        const name = `Custom Configuration ${Math.floor(1000 + Math.random() * 9000)}`;
        if (!existing.has(name.toLowerCase())) return name;
    }

    return `Custom Configuration ${Date.now()}`;
};

const normalizeProfileName = (name, fallback) => {
    const trimmed = String(name || '').trim();
    return (trimmed || fallback).slice(0, 80);
};

const createUserProfile = (name = null, baseProfile = null, existingProfiles = []) => {
    const source = baseProfile
        ? sanitizeProfile(baseProfile, 'Custom Configuration')
        : clone(createInstalledProfile());

    const profile = clone(source);
    profile.id = createProfileId();
    profile.name = normalizeProfileName(name, createGeneratedProfileName(existingProfiles));
    profile.isInstalled = false;
    profile.locked = false;
    return profile;
};

const normalizeFinalCleanupModelId = (modelId) => {
    const allowed = new Set(FINAL_CLEANUP_MODEL_OPTIONS.map(option => option.id));
    return allowed.has(modelId) ? modelId : 'auto';
};

const sanitizeStringList = (value, fallback = [], maxItems = 80) => {
    const source = Array.isArray(value) ? value : fallback;
    const seen = new Set();
    const result = [];

    for (const item of source) {
        const cleaned = String(item || '').replace(/\s+/g, ' ').trim();
        if (!cleaned || cleaned.length > 80) continue;

        const key = cleaned.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(cleaned);

        if (result.length >= maxItems) break;
    }

    return result;
};

const sanitizeReplacementList = (value, maxItems = 80) => {
    if (!Array.isArray(value)) return [];

    const seen = new Set();
    const result = [];

    for (const item of value) {
        const from = String(item?.from || '').replace(/\s+/g, ' ').trim();
        const to = String(item?.to || '').replace(/\s+/g, ' ').trim();

        if (!from || !to || from.length > 80 || to.length > 120) continue;
        if (from.toLowerCase() === to.toLowerCase()) continue;

        const key = from.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ from, to });

        if (result.length >= maxItems) break;
    }

    return result;
};

const sanitizeLocalStructureRules = (rules = {}) => {
    const incoming = rules && typeof rules === 'object' ? rules : {};

    return {
        enabled: typeof incoming.enabled === 'boolean' ? incoming.enabled : DEFAULT_LOCAL_STRUCTURE_RULES.enabled,
        phraseBreaks: typeof incoming.phraseBreaks === 'boolean' ? incoming.phraseBreaks : DEFAULT_LOCAL_STRUCTURE_RULES.phraseBreaks,
        spokenPointBreaks: typeof incoming.spokenPointBreaks === 'boolean' ? incoming.spokenPointBreaks : DEFAULT_LOCAL_STRUCTURE_RULES.spokenPointBreaks,
        standaloneNumberBreaks: typeof incoming.standaloneNumberBreaks === 'boolean' ? incoming.standaloneNumberBreaks : DEFAULT_LOCAL_STRUCTURE_RULES.standaloneNumberBreaks,
        decimalNumberBreaks: typeof incoming.decimalNumberBreaks === 'boolean' ? incoming.decimalNumberBreaks : DEFAULT_LOCAL_STRUCTURE_RULES.decimalNumberBreaks,
        ordinalBreaks: typeof incoming.ordinalBreaks === 'boolean' ? incoming.ordinalBreaks : DEFAULT_LOCAL_STRUCTURE_RULES.ordinalBreaks,
        groupLongParagraphs: typeof incoming.groupLongParagraphs === 'boolean' ? incoming.groupLongParagraphs : DEFAULT_LOCAL_STRUCTURE_RULES.groupLongParagraphs,
        phraseBreakCues: sanitizeStringList(incoming.phraseBreakCues, DEFAULT_LOCAL_STRUCTURE_RULES.phraseBreakCues),
        numberedPointCues: sanitizeStringList(incoming.numberedPointCues, DEFAULT_LOCAL_STRUCTURE_RULES.numberedPointCues, 30),
        customReplacements: sanitizeReplacementList(incoming.customReplacements),
    };
};

const sanitizePromptOverrides = (prompts = {}) => {
    const defaults = createDefaultLlmPromptOverrides();
    const result = {};

    for (const [intent, defaultPrompt] of Object.entries(defaults)) {
        const incoming = prompts[intent] || {};
        result[intent] = {
            enabled: typeof incoming.enabled === 'boolean' ? incoming.enabled : false,
            systemPrompt: typeof incoming.systemPrompt === 'string' && incoming.systemPrompt.trim()
                ? incoming.systemPrompt
                : defaultPrompt.systemPrompt,
            temperature: Number.isFinite(Number(incoming.temperature))
                ? Math.min(1.5, Math.max(0, Number(incoming.temperature)))
                : defaultPrompt.temperature,
        };
    }

    return result;
};

const sanitizeProfile = (profile = {}, fallbackName = 'Custom Configuration') => {
    const installed = createInstalledProfile();
    const finalCleanup = profile.finalCleanup || {};

    return {
        id: typeof profile.id === 'string' && profile.id.trim()
            ? profile.id.trim()
            : createProfileId(),
        name: typeof profile.name === 'string' && profile.name.trim()
            ? profile.name.trim().slice(0, 80)
            : fallbackName,
        isInstalled: false,
        locked: false,
        schemaVersion: PROFILE_SCHEMA_VERSION,
        finalCleanup: {
            modelId: normalizeFinalCleanupModelId(finalCleanup.modelId),
            systemPrompt: typeof finalCleanup.systemPrompt === 'string' && finalCleanup.systemPrompt.trim()
                ? finalCleanup.systemPrompt
                : installed.finalCleanup.systemPrompt,
            temperature: Number.isFinite(Number(finalCleanup.temperature))
                ? Math.min(1.5, Math.max(0, Number(finalCleanup.temperature)))
                : installed.finalCleanup.temperature,
            sendLocalStructureDraft: typeof finalCleanup.sendLocalStructureDraft === 'boolean'
                ? finalCleanup.sendLocalStructureDraft
                : true,
            localStructureRules: sanitizeLocalStructureRules(finalCleanup.localStructureRules),
        },
        llmPrompts: sanitizePromptOverrides(profile.llmPrompts),
    };
};

const sanitizeProfiles = (profiles) => {
    if (!Array.isArray(profiles) || profiles.length === 0) return [];

    const seen = new Set();
    const result = [];

    for (const [index, profile] of profiles.slice(0, 20).entries()) {
        if (!profile || profile.id === INSTALLED_PROFILE_ID || profile.isInstalled) {
            continue;
        }

        const sanitized = sanitizeProfile(profile, `Configuration ${index + 1}`);
        if (seen.has(sanitized.id) || sanitized.id === INSTALLED_PROFILE_ID) {
            sanitized.id = `${createProfileId()}-${index}`;
        }
        seen.add(sanitized.id);
        result.push(sanitized);
    }

    return result;
};

const getDeveloperConfigFromStore = (store) => {
    const enabled = store.get('developerSettingsEnabled', false) === true;
    const installedProfile = createInstalledProfile();
    const customProfiles = sanitizeProfiles(store.get('promptProfiles', null));
    const profiles = [installedProfile, ...customProfiles];
    let activeProfileId = store.get('activePromptProfileId', INSTALLED_PROFILE_ID);

    if (!profiles.some(profile => profile.id === activeProfileId)) {
        activeProfileId = INSTALLED_PROFILE_ID;
    }

    return {
        enabled,
        activeProfileId,
        profiles,
        installedProfile,
        intentLabels: INTENT_LABELS,
        finalCleanupModelOptions: FINAL_CLEANUP_MODEL_OPTIONS,
    };
};

const hasInstalledDraftChanges = (profile = {}) => {
    const installed = createInstalledProfile();
    const sanitized = sanitizeProfile(profile, installed.name);
    const nameChanged = normalizeProfileName(profile.name, installed.name) !== installed.name;
    const bodyChanged = JSON.stringify({
        finalCleanup: sanitized.finalCleanup,
        llmPrompts: sanitized.llmPrompts,
    }) !== JSON.stringify({
        finalCleanup: installed.finalCleanup,
        llmPrompts: installed.llmPrompts,
    });

    return nameChanged || bodyChanged;
};

const saveDeveloperConfigToStore = (store, config = {}) => {
    const incomingProfiles = Array.isArray(config.profiles) ? config.profiles : [];
    const installedDraft = incomingProfiles.find(profile => profile?.id === INSTALLED_PROFILE_ID);
    const installedName = createInstalledProfile().name;
    let profiles = sanitizeProfiles(incomingProfiles);
    let activeProfileId = typeof config.activeProfileId === 'string'
        ? config.activeProfileId
        : INSTALLED_PROFILE_ID;

    if (activeProfileId === INSTALLED_PROFILE_ID && installedDraft && hasInstalledDraftChanges(installedDraft)) {
        const requestedName = normalizeProfileName(installedDraft.name, '');
        const customName = requestedName && requestedName !== installedName
            ? requestedName
            : createGeneratedProfileName(profiles);
        const newProfile = createUserProfile(customName, installedDraft, profiles);
        profiles = [...profiles, newProfile];
        activeProfileId = newProfile.id;
    }

    if (activeProfileId !== INSTALLED_PROFILE_ID && !profiles.some(profile => profile.id === activeProfileId)) {
        activeProfileId = INSTALLED_PROFILE_ID;
    }

    store.set('developerSettingsEnabled', config.enabled === true);
    store.set('promptProfiles', profiles);
    store.set('activePromptProfileId', activeProfileId);

    return getDeveloperConfigFromStore(store);
};

const getActiveProfileFromStore = (store) => {
    const config = getDeveloperConfigFromStore(store);
    return config.profiles.find(profile => profile.id === config.activeProfileId) || config.installedProfile;
};

// Heuristic: a finished transcript that is already short and has terminal punctuation
// rarely benefits from LLM cleanup. Skipping the LLM saves several seconds of latency
// for the common "send a quick command" dictation case. Local structure rules still run.
const SHORT_CLEANUP_LENGTH_LIMIT = 250;
const TERMINAL_PUNCTUATION_PATTERN = /[.!?…]["'”’)\]]?\s*$/;

const shouldSkipFinalCleanup = (rawText) => {
    const text = String(rawText || '').trim();
    if (!text) return true;
    if (text.length >= SHORT_CLEANUP_LENGTH_LIMIT) return false;
    return TERMINAL_PUNCTUATION_PATTERN.test(text);
};

const renderPromptTemplate = (template, values = {}) => {
    let result = String(template || '');
    for (const [key, value] of Object.entries(values)) {
        result = result.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), String(value || ''));
    }
    return result;
};

module.exports = {
    PROFILE_SCHEMA_VERSION,
    INSTALLED_PROFILE_ID,
    DEFAULT_FINAL_CLEANUP_PROMPT,
    DEFAULT_LOCAL_STRUCTURE_RULES,
    FINAL_CLEANUP_MODEL_OPTIONS,
    INTENT_LABELS,
    SHORT_CLEANUP_LENGTH_LIMIT,
    createInstalledProfile,
    createUserProfile,
    createGeneratedProfileName,
    sanitizeProfile,
    sanitizeLocalStructureRules,
    getDeveloperConfigFromStore,
    saveDeveloperConfigToStore,
    getActiveProfileFromStore,
    renderPromptTemplate,
    shouldSkipFinalCleanup,
};
