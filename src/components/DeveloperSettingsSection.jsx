import { useEffect, useMemo, useState } from 'react';

const RULE_LABELS = {
    enabled: 'Run local structure cleanup',
    phraseBreaks: 'Break on transition phrases',
    spokenPointBreaks: 'Convert spoken point markers',
    standaloneNumberBreaks: 'Convert standalone number words',
    decimalNumberBreaks: 'Convert 0.1 / 0.2 markers',
    ordinalBreaks: 'Break on first / second / third',
    groupLongParagraphs: 'Split very long paragraphs',
};

const RULE_HELP = {
    enabled: 'Master switch for local cleanup. Example: when off, Quilly will not apply its local paragraph/list cleanup before or after the model.',
    phraseBreaks: 'Adds paragraph breaks before transition phrases. Example: "on another point the dot is working" starts a new paragraph.',
    spokenPointBreaks: 'Turns spoken point markers into numbered paragraphs. Example: "number one test this number two check that" becomes "1. test this" and "2. check that".',
    standaloneNumberBreaks: 'Continues a numbered list when Whisper writes number words. Example: after "1.", "Two, check the terminal" becomes "2. check the terminal".',
    decimalNumberBreaks: 'Turns decimal-like spoken markers into list items. Example: "0.1 first thing 0.2 second thing" becomes "1. first thing" and "2. second thing".',
    ordinalBreaks: 'Splits repeated ordinal cues. Example: "first check the prompt second test the output" becomes separate sections.',
    groupLongParagraphs: 'Splits very long paragraphs into smaller groups when punctuation is already present.',
};

const LOCAL_DRAFT_HELP = 'Sends the model two inputs: raw Whisper text plus Quilly\'s local structured draft. Example: raw "number one..." and draft "1. ..." so the model can keep the useful structure while polishing wording.';
const PHRASE_CUES_HELP = 'One phrase per line. When local cleanup sees one of these phrases, it starts a new paragraph before it. Example: "another issue".';
const NUMBERED_CUES_HELP = 'One cue per line. Quilly converts cue + number into a numbered paragraph. Example: "item one apples item two oranges" becomes "1. apples" and "2. oranges".';
const CUSTOM_REPLACEMENTS_HELP = 'One replacement per line using "wrong => right". These are exact word or phrase fixes before paragraph cleanup. Example: "Microsoft => microphone".';

const listToText = (list) => (Array.isArray(list) ? list.join('\n') : '');

const textToList = (text) => String(text || '')
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

const replacementsToText = (list) => (
    Array.isArray(list)
        ? list.map(item => `${item.from || ''} => ${item.to || ''}`).join('\n')
        : ''
);

const textToReplacements = (text) => String(text || '')
    .split(/\r?\n/)
    .map((line) => {
        const separator = line.includes('=>') ? '=>' : line.includes('->') ? '->' : null;
        if (!separator) return null;
        const [from, ...rest] = line.split(separator);
        const to = rest.join(separator);
        return {
            from: from.replace(/\s+/g, ' ').trim(),
            to: to.replace(/\s+/g, ' ').trim(),
        };
    })
    .filter(item => item?.from && item?.to);

const createClientProfileId = () => `profile-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

const createGeneratedProfileName = (profiles = []) => {
    const existing = new Set(
        profiles.map(profile => String(profile?.name || '').trim().toLowerCase()).filter(Boolean)
    );
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const name = `Custom Configuration ${Math.floor(1000 + Math.random() * 9000)}`;
        if (!existing.has(name.toLowerCase())) return name;
    }
    return `Custom Configuration ${Date.now()}`;
};

const cloneProfile = (profile) => JSON.parse(JSON.stringify(profile));

function DeveloperSettingsSection({ llmModels }) {
    const [config, setConfig] = useState(null);
    const [savedConfig, setSavedConfig] = useState(null);
    const selectedIntent = 'freeform';
    const [status, setStatus] = useState(null);
    const [error, setError] = useState(null);
    const [testInput, setTestInput] = useState('');
    const [testResult, setTestResult] = useState(null);
    const [isTesting, setIsTesting] = useState(false);
    const [freeformTestInput, setFreeformTestInput] = useState('');
    const [freeformTestResult, setFreeformTestResult] = useState(null);
    const [isTestingFreeform, setIsTestingFreeform] = useState(false);
    // Raw text drafts for the cue/replacement textareas. Parsing on every
    // keystroke normalizes away trailing spaces/newlines and drops incomplete
    // "a => b" lines, which erases input as it's typed. The raw text lives
    // here while editing and is parsed once on blur.
    const [ruleDrafts, setRuleDrafts] = useState({});

    const loadConfig = async () => {
        try {
            const loaded = await window.electronAPI.developerConfigGet?.();
            setConfig(loaded);
            setSavedConfig(loaded);
            setError(null);
        } catch (err) {
            setError(err.message || 'Failed to load developer settings');
        }
    };

    useEffect(() => {
        loadConfig();
    }, []);

    const activeProfile = useMemo(() => {
        if (!config?.profiles?.length) return null;
        return config.profiles.find(profile => profile.id === config.activeProfileId) || config.profiles[0];
    }, [config]);

    // Discard unfinished textarea drafts when switching profiles so text
    // typed in one profile never bleeds into another.
    useEffect(() => {
        setRuleDrafts({});
    }, [activeProfile?.id]);

    const activePrompt = activeProfile?.llmPrompts?.[selectedIntent] || null;
    const hasUnsavedChanges = useMemo(() => (
        !!config && !!savedConfig && JSON.stringify(config) !== JSON.stringify(savedConfig)
    ), [config, savedConfig]);

    const updateConfig = (updater) => {
        setConfig(prev => {
            if (!prev) return prev;
            return updater(prev);
        });
        setStatus(null);
        setError(null);
    };

    const updateActiveProfile = (updater) => {
        updateConfig(prev => ({
            ...prev,
            ...(() => {
                const active = prev.profiles.find(profile => profile.id === prev.activeProfileId) || prev.profiles[0];
                if (active?.isInstalled || active?.locked) {
                    const draftProfile = updater({
                        ...cloneProfile(active),
                        id: createClientProfileId(),
                        name: createGeneratedProfileName(prev.profiles),
                        isInstalled: false,
                        locked: false,
                    });
                    const draft = {
                        ...draftProfile,
                        name: String(draftProfile.name || '').trim() || createGeneratedProfileName(prev.profiles),
                    };
                    return {
                        profiles: [...prev.profiles, draft],
                        activeProfileId: draft.id,
                    };
                }

                return {
                    profiles: prev.profiles.map(profile =>
                        profile.id === prev.activeProfileId ? updater(profile) : profile
                    ),
                };
            })(),
        }));
    };

    const updateFinalCleanup = (patch) => {
        updateActiveProfile(profile => ({
            ...profile,
            finalCleanup: {
                ...profile.finalCleanup,
                ...patch,
            },
        }));
    };

    const updateRule = (ruleKey, value) => {
        updateActiveProfile(profile => ({
            ...profile,
            finalCleanup: {
                ...profile.finalCleanup,
                localStructureRules: {
                    ...profile.finalCleanup.localStructureRules,
                    [ruleKey]: value,
                },
            },
        }));
    };

    const draftOr = (key, serialized) => (ruleDrafts[key] !== undefined ? ruleDrafts[key] : serialized);

    const setRuleDraft = (key, text) => setRuleDrafts(prev => ({ ...prev, [key]: text }));

    const commitRuleDraft = (key, parser) => {
        const draft = ruleDrafts[key];
        if (draft === undefined) return;
        updateRule(key, parser(draft));
        setRuleDrafts(prev => {
            const next = { ...prev };
            delete next[key];
            return next;
        });
    };

    const updatePrompt = (intent, patch) => {
        updateActiveProfile(profile => ({
            ...profile,
            llmPrompts: {
                ...profile.llmPrompts,
                [intent]: {
                    ...profile.llmPrompts[intent],
                    ...patch,
                },
            },
        }));
    };

    const saveConfig = async (nextConfig = config, message = 'Configuration saved') => {
        if (!nextConfig) return;
        try {
            const previousActiveId = nextConfig.activeProfileId;
            const saved = await window.electronAPI.developerConfigSave?.(nextConfig);
            setConfig(saved);
            setSavedConfig(saved);
            const installedId = saved?.installedProfile?.id || 'installed-default';
            setStatus(previousActiveId === installedId && saved.activeProfileId !== installedId
                ? 'Default copied to a new custom configuration'
                : message);
            setError(null);
        } catch (err) {
            setError(err.message || 'Failed to save developer settings');
        }
    };

    const toggleEnabled = async () => {
        if (!config) return;
        const enabled = !config.enabled;
        try {
            await window.electronAPI.setSetting('developerSettingsEnabled', enabled);
            setConfig(prev => prev ? { ...prev, enabled } : prev);
            setSavedConfig(prev => prev ? { ...prev, enabled } : prev);
            setStatus(enabled ? 'Developer settings enabled' : 'Developer settings disabled');
            setError(null);
        } catch (err) {
            setError(err.message || 'Failed to save developer setting');
        }
    };

    const saveAsNew = async () => {
        if (!config || !activeProfile) return;
        const isInstalled = activeProfile.isInstalled || activeProfile.locked;
        const copy = {
            ...cloneProfile(activeProfile),
            id: createClientProfileId(),
            name: isInstalled ? createGeneratedProfileName(config.profiles) : `${activeProfile.name} Copy`,
            isInstalled: false,
            locked: false,
        };
        await saveConfig({
            ...config,
            profiles: [...config.profiles, copy],
            activeProfileId: copy.id,
        }, 'New configuration created');
    };

    const deleteProfile = async () => {
        if (!config || !activeProfile || activeProfile.isInstalled || activeProfile.locked) return;
        const remaining = config.profiles.filter(profile => profile.id !== activeProfile.id);
        const activeProfileId = remaining.some(profile => profile.id === config.installedProfile?.id)
            ? config.installedProfile.id
            : remaining[0]?.id;
        await saveConfig({
            ...config,
            profiles: remaining,
            activeProfileId,
        }, 'Configuration deleted');
    };

    const resetActive = async () => {
        if (!activeProfile) return;
        if (activeProfile.isInstalled || activeProfile.locked) {
            setStatus('Installed configuration is already at defaults');
            return;
        }
        const confirmed = window.confirm('Reset this configuration to the installed Quilly defaults?');
        if (!confirmed) return;
        try {
            const reset = await window.electronAPI.developerConfigResetActive?.(activeProfile.id);
            setConfig(reset);
            setSavedConfig(reset);
            setStatus('Configuration reset to installed defaults');
            setError(null);
        } catch (err) {
            setError(err.message || 'Failed to reset configuration');
        }
    };

    const runFreeformTest = async () => {
        if (!activeProfile || !freeformTestInput.trim()) return;
        setIsTestingFreeform(true);
        setFreeformTestResult(null);
        setError(null);
        try {
            const result = await window.electronAPI.developerConfigTestFreeform?.({
                text: freeformTestInput,
                profile: activeProfile,
            });
            setFreeformTestResult(result);
        } catch (err) {
            setError(err.message || 'Freeform test failed');
        } finally {
            setIsTestingFreeform(false);
        }
    };

    const runTest = async () => {
        if (!activeProfile || !testInput.trim()) return;
        setIsTesting(true);
        setTestResult(null);
        setError(null);
        try {
            const result = await window.electronAPI.developerConfigTestFinalCleanup?.({
                text: testInput,
                profile: activeProfile,
            });
            setTestResult(result);
        } catch (err) {
            setError(err.message || 'Final cleanup test failed');
        } finally {
            setIsTesting(false);
        }
    };

    if (!config || !activeProfile) {
        return (
            <section className="settings-section developer-section">
                <h3>Developer Settings</h3>
                <p className="section-description">Loading advanced configuration...</p>
            </section>
        );
    }

    const finalCleanupModelOptions = config.finalCleanupModelOptions || [];
    const activeIsInstalled = activeProfile.isInstalled || activeProfile.locked;

    return (
        <section className="settings-section developer-section">
            <div className="developer-header-row">
                <div>
                    <h3>Developer Settings</h3>
                    <p className="section-description">
                        Advanced prompt, model, cleanup, and profile controls.
                    </p>
                </div>
                <button
                    className={`llm-switch ${config.enabled ? 'llm-switch--on' : ''}`}
                    role="switch"
                    aria-checked={config.enabled}
                    onClick={toggleEnabled}
                    type="button"
                >
                    <span className="llm-switch-thumb" />
                </button>
            </div>

            {!config.enabled && (
                <p className="developer-muted">
                    Enable this only when you want to edit model instructions, final cleanup prompts, or switch saved Quilly configurations.
                </p>
            )}

            {config.enabled && (
                <div className="developer-panel">
                    <div className="developer-profile-grid">
                        <label className="developer-field">
                            <span>Active configuration</span>
                            <select
                                value={config.activeProfileId}
                                onChange={(e) => updateConfig(prev => ({ ...prev, activeProfileId: e.target.value }))}
                            >
                                {config.profiles.map(profile => (
                                    <option key={profile.id} value={profile.id}>{profile.name}</option>
                                ))}
                            </select>
                        </label>

                        <label className="developer-field">
                            <span>{activeIsInstalled ? 'New custom name' : 'Name'}</span>
                            <input
                                value={activeIsInstalled ? '' : activeProfile.name}
                                placeholder={activeIsInstalled ? 'Type to create a named custom configuration' : ''}
                                onChange={(e) => updateActiveProfile(profile => ({ ...profile, name: e.target.value }))}
                            />
                        </label>
                    </div>

                    <div className="developer-actions">
                        <button type="button" className="primary-btn" onClick={() => saveConfig()}>
                            Save Configuration
                        </button>
                        <button type="button" className="secondary-btn" onClick={saveAsNew}>
                            Save as New
                        </button>
                        <button type="button" className="secondary-btn" onClick={resetActive} disabled={activeIsInstalled}>
                            Reset to Installed
                        </button>
                        <button type="button" className="danger-btn" onClick={deleteProfile} disabled={activeIsInstalled}>
                            Delete
                        </button>
                    </div>

                    {activeIsInstalled && (
                        <p className="developer-muted">
                            Installed Configuration is a read-only factory preset. Editing any field creates an unsaved custom configuration.
                        </p>
                    )}

                    {hasUnsavedChanges && (
                        <p className="developer-unsaved">
                            Unsaved changes. Real recordings use the last saved configuration; test benches use this draft.
                        </p>
                    )}
                    {status && <p className="developer-status">{status}</p>}
                    {error && <p className="developer-error">{error}</p>}

                    <div className="developer-subsection">
                        <h4>Final Transcript Cleanup</h4>
                        <div className="developer-profile-grid">
                            <label className="developer-field">
                                <span>Cleanup model</span>
                                <select
                                    value={activeProfile.finalCleanup.modelId}
                                    onChange={(e) => updateFinalCleanup({ modelId: e.target.value })}
                                >
                                    {finalCleanupModelOptions.map(option => {
                                        const installed = option.id === 'auto'
                                            ? Object.values(llmModels || {}).some(model => model.installed)
                                            : llmModels?.[option.id]?.installed;
                                        return (
                                            <option key={option.id} value={option.id}>
                                                {option.label}{installed ? '' : ' - not downloaded'}
                                            </option>
                                        );
                                    })}
                                </select>
                            </label>
                            <label className="developer-field">
                                <span>Temperature</span>
                                <input
                                    type="number"
                                    min="0"
                                    max="1.5"
                                    step="0.1"
                                    value={activeProfile.finalCleanup.temperature}
                                    onChange={(e) => updateFinalCleanup({ temperature: Number(e.target.value) })}
                                />
                            </label>
                        </div>

                        <label className="developer-checkbox">
                            <input
                                type="checkbox"
                                checked={activeProfile.finalCleanup.sendLocalStructureDraft !== false}
                                onChange={(e) => updateFinalCleanup({ sendLocalStructureDraft: e.target.checked })}
                            />
                            <InfoLabel text="Send local structured draft to the model as a reference" help={LOCAL_DRAFT_HELP} />
                        </label>

                        <label className="developer-field">
                            <span>System prompt</span>
                            <textarea
                                className="developer-textarea developer-textarea--large"
                                value={activeProfile.finalCleanup.systemPrompt}
                                onChange={(e) => updateFinalCleanup({ systemPrompt: e.target.value })}
                            />
                        </label>

                        <div className="developer-rules-grid">
                            {Object.entries(RULE_LABELS).map(([key, label]) => (
                                <label key={key} className="developer-checkbox">
                                    <input
                                        type="checkbox"
                                        checked={activeProfile.finalCleanup.localStructureRules?.[key] !== false}
                                        onChange={(e) => updateRule(key, e.target.checked)}
                                    />
                                    <InfoLabel text={label} help={RULE_HELP[key]} />
                                </label>
                            ))}
                        </div>

                        <div className="developer-profile-grid">
                            <label className="developer-field">
                                <InfoLabel text="Paragraph cue phrases" help={PHRASE_CUES_HELP} />
                                <textarea
                                    className="developer-textarea developer-textarea--small"
                                    value={draftOr('phraseBreakCues', listToText(activeProfile.finalCleanup.localStructureRules?.phraseBreakCues))}
                                    onChange={(e) => setRuleDraft('phraseBreakCues', e.target.value)}
                                    onBlur={() => commitRuleDraft('phraseBreakCues', textToList)}
                                    placeholder={'on another point\nanother issue\nfinally'}
                                />
                            </label>
                            <label className="developer-field">
                                <InfoLabel text="Numbered cue phrases" help={NUMBERED_CUES_HELP} />
                                <textarea
                                    className="developer-textarea developer-textarea--small"
                                    value={draftOr('numberedPointCues', listToText(activeProfile.finalCleanup.localStructureRules?.numberedPointCues))}
                                    onChange={(e) => setRuleDraft('numberedPointCues', e.target.value)}
                                    onBlur={() => commitRuleDraft('numberedPointCues', textToList)}
                                    placeholder={'point number\npoint\nnumber'}
                                />
                            </label>
                        </div>

                        <label className="developer-field">
                            <InfoLabel text="Custom replacements" help={CUSTOM_REPLACEMENTS_HELP} />
                            <textarea
                                className="developer-textarea developer-textarea--small"
                                value={draftOr('customReplacements', replacementsToText(activeProfile.finalCleanup.localStructureRules?.customReplacements))}
                                onChange={(e) => setRuleDraft('customReplacements', e.target.value)}
                                onBlur={() => commitRuleDraft('customReplacements', textToReplacements)}
                                placeholder={'Microsoft => microphone\nbottom => button'}
                            />
                        </label>

                        <h4>Final Cleanup Test Bench</h4>
                        <label className="developer-field">
                            <span>Paste a Whisper transcript</span>
                            <textarea
                                className="developer-textarea"
                                value={testInput}
                                onChange={(e) => setTestInput(e.target.value)}
                                placeholder="Paste a rough transcript here and test final cleanup without recording again."
                            />
                        </label>
                        <div className="developer-actions">
                            <button type="button" className="primary-btn" onClick={runTest} disabled={isTesting || !testInput.trim()}>
                                {isTesting ? 'Testing...' : 'Test Final Cleanup'}
                            </button>
                        </div>

                        {testResult?.diagnostics && (
                            <div className="developer-test-results">
                                <ResultBlock title="Local structure output" text={testResult.diagnostics.localStructureOutput} />
                                <ResultBlock title="Selected final output" text={testResult.diagnostics.selectedOutput || testResult.cleanup?.text} />
                                {testResult.diagnostics.error && (
                                    <ResultBlock title="Model error" text={testResult.diagnostics.error} />
                                )}
                            </div>
                        )}
                    </div>

                    <div className="developer-subsection">
                        <h4>LLM Processing Instructions</h4>
                        <p className="developer-muted">
                            Quilly hotkey processing and dashboard processing use the freeform prompt.
                        </p>
                        <div className="developer-profile-grid developer-profile-grid--single">
                            <label className="developer-field">
                                <span>Temperature</span>
                                <input
                                    type="number"
                                    min="0"
                                    max="1.5"
                                    step="0.1"
                                    value={activePrompt?.temperature ?? 0.5}
                                    onChange={(e) => updatePrompt(selectedIntent, { temperature: Number(e.target.value) })}
                                />
                            </label>
                        </div>
                        <label className="developer-checkbox">
                            <input
                                type="checkbox"
                                checked={activePrompt?.enabled === true}
                                onChange={(e) => updatePrompt(selectedIntent, { enabled: e.target.checked })}
                            />
                            <span>Use this custom freeform prompt</span>
                        </label>
                        <label className="developer-field">
                            <span>System prompt</span>
                            <textarea
                                className="developer-textarea developer-textarea--large"
                                value={activePrompt?.systemPrompt || ''}
                                onChange={(e) => updatePrompt(selectedIntent, { systemPrompt: e.target.value })}
                            />
                        </label>

                        <h4>Freeform Test Bench</h4>
                        <label className="developer-field">
                            <span>Paste a voice command or dashboard-style instruction/content</span>
                            <textarea
                                className="developer-textarea"
                                value={freeformTestInput}
                                onChange={(e) => setFreeformTestInput(e.target.value)}
                                placeholder="Example: make this clearer I need to send the team a quick update about the schedule"
                            />
                        </label>
                        <div className="developer-actions">
                            <button type="button" className="primary-btn" onClick={runFreeformTest} disabled={isTestingFreeform || !freeformTestInput.trim()}>
                                {isTestingFreeform ? 'Testing...' : 'Test Freeform Processing'}
                            </button>
                        </div>

                        {freeformTestResult && (
                            <div className="developer-test-results">
                                {freeformTestResult.success ? (
                                    <ResultBlock title="Freeform output" text={freeformTestResult.diagnostics?.output || freeformTestResult.result?.output} />
                                ) : (
                                    <ResultBlock title="Freeform error" text={freeformTestResult.error} />
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </section>
    );
}

function InfoLabel({ text, help }) {
    return (
        <span className="developer-info-label">
            <span>{text}</span>
            <button type="button" className="developer-info-button" title={help} aria-label={`${text}: ${help}`}>
                i
            </button>
        </span>
    );
}

function ResultBlock({ title, text }) {
    if (!text) return null;
    return (
        <div className="developer-result-block">
            <span>{title}</span>
            <pre>{text}</pre>
        </div>
    );
}

export default DeveloperSettingsSection;
