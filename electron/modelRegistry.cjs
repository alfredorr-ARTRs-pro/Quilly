'use strict';

// modelRegistry.cjs — single source of truth for model metadata.
//
// Pure data module: no Electron imports at module level, no side effects at require time.
// All IPC handlers and future UI phases reference this module — never llamaDownloader.MODELS
// directly — to ensure consistent labels, sizes, and intent mappings across the codebase.
//
// Public API:
//   REGISTRY       — { [modelId]: { id, label, technicalName, sizeLabel, intents, ...downloadFields } }
//   getModelStatus() — Returns REGISTRY entries augmented with installed:boolean per model.
//   getModelForIntent(intent) — Returns the model ID that handles a given intent string, or null.

const llamaDownloader = require('./llamaDownloader.cjs');
const fs = require('fs');
const path = require('path');

// ─── Registry ─────────────────────────────────────────────────────────────────

/**
 * Central model registry. Spreads llamaDownloader.MODELS download fields (filename, url,
 * sizeApprox, repo) into each entry and adds UI-facing metadata (id, label, technicalName,
 * sizeLabel, intents).
 *
 * Both Qwen 3.5 models handle ALL intents. Model selection is based on user preference
 * (auto/4b/9b), not intent routing. Auto mode picks the best installed model.
 */
const ALL_INTENTS = ['translate', 'formal', 'professional', 'email', 'report', 'grammar', 'rewrite', 'concise', 'analyze'];

const REGISTRY = {
    'qwen3.5-4b': {
        id: 'qwen3.5-4b',
        label: 'Fast Model',
        technicalName: 'Qwen3.5-4B (Q4_K_M)',
        sizeLabel: '~2.7 GB',
        intents: ALL_INTENTS,
        ...llamaDownloader.MODELS['qwen3.5-4b'],
    },
    'qwen3.5-9b': {
        id: 'qwen3.5-9b',
        label: 'Quality Model',
        technicalName: 'Qwen3.5-9B (Q4_K_M)',
        sizeLabel: '~5.7 GB',
        intents: ALL_INTENTS,
        ...llamaDownloader.MODELS['qwen3.5-9b'],
    },
};

// ─── getModelStatus ────────────────────────────────────────────────────────────

/**
 * Returns the REGISTRY entries augmented with an installed:boolean field per model.
 * installed is determined by checking whether the model GGUF file exists on disk.
 *
 * When called outside of an Electron process (e.g., tests), getModelsPath() will fail
 * because app.getPath() is unavailable. In that case, installed defaults to false for all
 * models — the registry labels and intent data remain fully usable.
 *
 * Used by: llm:get-model-status IPC handler in main.cjs (Plan 02).
 *
 * @returns {{ [modelId: string]: object }} — REGISTRY entry spread with installed:boolean
 */
const getModelStatus = () => {
    let modelsPath = null;

    try {
        modelsPath = llamaDownloader.getModelsPath();
    } catch (_) {
        // Outside Electron context — app.getPath() unavailable; installed defaults to false
        modelsPath = null;
    }

    const result = {};

    for (const [id, model] of Object.entries(REGISTRY)) {
        let installed = false;

        if (modelsPath !== null) {
            try {
                installed = fs.existsSync(path.join(modelsPath, model.filename));
            } catch (_) {
                installed = false;
            }
        }

        result[id] = {
            ...model,
            installed,
        };
    }

    return result;
};

// ─── getModelForIntent ─────────────────────────────────────────────────────────

/**
 * Given an intent string, returns the model ID whose intents array includes it.
 * Iterates REGISTRY entries in insertion order and returns the first match.
 *
 * Used by: model pre-check in main.cjs before calling pipeline.processTranscribedText.
 *
 * @param {string} intent - intent string (e.g., 'translate', 'formal', 'grammar')
 * @returns {string|null} — model ID (e.g., 'qwen3.5-9b') or null if no match
 */
const getModelForIntent = (intent) => {
    for (const [id, model] of Object.entries(REGISTRY)) {
        if (model.intents.includes(intent)) {
            return id;
        }
    }
    return null;
};

// ─── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
    REGISTRY,
    getModelStatus,
    getModelForIntent,
};
