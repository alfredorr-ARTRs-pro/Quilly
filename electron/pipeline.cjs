'use strict';

// pipeline.cjs — orchestration: Whisper → intentRouter → llamaService → result
//
// Receives audio data and optional clipboard text, runs through the full
// processing pipeline, and returns a PipelineResult. Does NOT import
// electron — clipboard capture lives in main.cjs and is passed as a parameter.
//
// Public API:
//   processRecording(audioData, clipboardText, options) → Promise<PipelineResult>
//   processTranscribedText(rawText, clipboardText, options) → Promise<PipelineResult>
//   processChainedText(rawText, routeResults, clipboardText, options) → Promise<ChainedPipelineResult>
//
// Internal API (exposed via _internal for testing):
//   buildUserContent(speechContent, clipboardText, intent) → { text, wasTruncated }
//   sanitizeOutput(llmOutput, fallbackText) → string

const whisperCppService = require('./whisperCppService.cjs');
const intentRouter = require('./intentRouter.cjs');
const llamaService = require('./llamaService.cjs');
const { PROMPT_TEMPLATES } = require('./promptTemplates.cjs');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Approx 1000 tokens at avg 4 chars/token — matches context window budget */
const CONTEXT_WINDOW_CHARS = 4000;

/** Matches UI-02 indicator forced timeout */
const PIPELINE_TIMEOUT_MS = 120000;

// ─── buildUserContent ─────────────────────────────────────────────────────────

/**
 * Build the LLM user message content from speech and optional clipboard text.
 *
 * When both present: "Spoken content: {speech}\n\nClipboard content:\n{clip}"
 * When only speech:  "{speech}" (no prefix — avoids translated prefix like "Contenido hablado:")
 * When only clip:    "Clipboard content:\n{clip}"
 *
 * Clipboard text is truncated to CONTEXT_WINDOW_CHARS if longer.
 * Truncation is reflected in the label: "Clipboard content (truncated to 4000 characters):"
 *
 * @param {string|null} speechContent
 * @param {string|null} clipboardText
 * @param {string} intent
 * @returns {{ text: string, wasTruncated: boolean }}
 */
const buildUserContent = (speechContent, clipboardText, intent) => {
    let wasTruncated = false;
    let clip = clipboardText || null;

    if (clip && clip.length > CONTEXT_WINDOW_CHARS) {
        clip = clip.slice(0, CONTEXT_WINDOW_CHARS);
        wasTruncated = true;
    }

    const clipLabel = wasTruncated
        ? `Clipboard content (truncated to 4000 characters):`
        : `Clipboard content:`;

    if (speechContent && clip) {
        return {
            text: `Spoken content: ${speechContent}\n\n${clipLabel}\n${clip}`,
            wasTruncated,
        };
    }

    if (speechContent) {
        return {
            text: speechContent,
            wasTruncated: false,
        };
    }

    if (clip) {
        return {
            text: `${clipLabel}\n${clip}`,
            wasTruncated,
        };
    }

    // Fallback: empty content
    return { text: '', wasTruncated: false };
};

// ─── sanitizeOutput ───────────────────────────────────────────────────────────

/**
 * Guard against bad LLM output — falls back to rawText when output is
 * empty, a system-prompt echo, or contains excessive repetition.
 *
 * Check 1: trimmed empty → return fallbackText
 * Check 2: starts with "you are " or "system:" (case-insensitive) → return fallbackText
 * Check 3: if words.length >= 9, compare first third to last third — if equal → return fallbackText
 *
 * @param {string|null|undefined} llmOutput
 * @param {string} fallbackText
 * @returns {string}
 */
const sanitizeOutput = (llmOutput, fallbackText) => {
    // Check 0: null / undefined / empty
    if (llmOutput == null) {
        console.warn('[sanitize] LLM output is null/undefined — using fallback');
        return fallbackText;
    }

    // Strip Qwen 3.5 thinking blocks — model may produce <think>...</think> reasoning
    const stripped = String(llmOutput).replace(/<think>[\s\S]*?<\/think>/g, '');
    const trimmed = stripped.trim();
    if (trimmed.length === 0) {
        console.warn('[sanitize] LLM output empty after stripping <think> blocks — using fallback');
        return fallbackText;
    }

    // Check 2: system prompt echo detection (case-insensitive)
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('you are ') || lower.startsWith('system:')) {
        console.warn('[sanitize] LLM echoed system prompt — using fallback');
        return fallbackText;
    }

    // Check 3: excessive repetition — compare first third to last third
    const words = trimmed.split(/\s+/);
    if (words.length >= 9) {
        const third = Math.floor(words.length / 3);
        const firstThird = words.slice(0, third).join(' ');
        const lastThird = words.slice(words.length - third).join(' ');
        if (firstThird === lastThird) {
            console.warn('[sanitize] Excessive repetition detected — using fallback');
            return fallbackText;
        }
    }

    // Check 4: Strip LLM preamble and postamble — model often adds explanatory text
    // despite "Output ONLY" instructions. Remove common intro/outro patterns.
    const cleaned = stripPreamble(trimmed);
    return cleaned.length > 0 ? cleaned : trimmed;
};

/**
 * Remove common LLM preamble/postamble patterns from output.
 * Keeps only the actual content the user wants pasted.
 */
const stripPreamble = (text) => {
    let result = text;

    // Strip leading preamble lines: "Here is the ...", "Sure, here's ...", etc.
    // Match one or more preamble lines at the start, followed by a blank line or colon+newline
    result = result.replace(
        /^(?:(?:here(?:'s| is| are)|sure[,!]|of course[,!]|certainly[,!]|i(?:'ve| have))[^\n]*(?:\n|:\s*\n))+\s*/i,
        ''
    );

    // Strip trailing postamble: "I translated...", "Note:...", "Let me know...", "I hope..."
    result = result.replace(
        /\n\s*\n(?:(?:i (?:translated|rewrote|converted|reformatted|made|fixed|corrected|hope)|note:|let me know|feel free|if you)[^\n]*\n?)+\s*$/i,
        ''
    );

    // Strip markdown code fences that wrap the entire output
    const fenceMatch = result.match(/^```[\w]*\n([\s\S]*?)\n```\s*$/);
    if (fenceMatch) {
        result = fenceMatch[1];
    }

    return result.trim();
};

// ─── _runLlmPipeline ──────────────────────────────────────────────────────────

/**
 * Shared Steps 5-12: prompt template lookup, LLM inference, output sanitization, timeout.
 * Called by both processRecording (after Steps 1-4) and processTranscribedText (after routing).
 *
 * Extracted to prevent code drift between the two entry points. processRecording and
 * processTranscribedText diverge only in Steps 1-4 (transcription and PROC-06 Whisper path);
 * from the prompt template lookup onward, the logic is identical.
 *
 * @param {object} routeResult - result of intentRouter.route()
 * @param {string} rawText - original transcription text (used as LLM fallback and rawTranscription)
 * @param {string|null} clipboardText
 * @param {object} options
 * @param {boolean} usedWhisperTranslate - true if PROC-06 path was already taken upstream
 * @returns {Promise<PipelineResult>}
 */
const _runLlmPipeline = async (routeResult, rawText, clipboardText, options, usedWhisperTranslate = false) => {
    // Step 5: Look up prompt template for this intent
    const template = PROMPT_TEMPLATES[routeResult.intent] || PROMPT_TEMPLATES.rewrite;

    // Step 6: Compute system prompt — factory function or direct string
    let systemPrompt =
        typeof template.systemPrompt === 'function'
            ? template.systemPrompt(routeResult.targetLanguage)
            : template.systemPrompt;

    // Step 6a: For non-translate intents, instruct the LLM to respond in the input's language.
    // Must be emphatic — small models (Qwen 3.5-4B/9B) default to English when the system
    // prompt is entirely in English unless the language constraint is very explicit.
    if (routeResult.intent !== 'translate') {
        systemPrompt += '\n\nIMPORTANT: You MUST respond in the same language as the input text. If the input is in Spanish, respond in Spanish. If the input is in French, respond in French. Do NOT translate to English unless the input is already in English.';
    }

    // Step 6c: Editor freeform override — when instruction is explicitly separated,
    // embed it directly in the system prompt instead of asking the LLM to parse it.
    // Uses a directive RULES format that small Qwen models follow reliably.
    if (options.editorInstruction && routeResult.intent === 'freeform') {
        systemPrompt = 'You are a text processing assistant.\n\n'
            + `INSTRUCTION: ${options.editorInstruction}\n\n`
            + 'RULES:\n'
            + '1. Apply the INSTRUCTION to the CONTENT provided by the user.\n'
            + '2. Output ONLY the processed result.\n'
            + '3. Do NOT repeat the instruction, add explanations, or add commentary.\n'
            + '4. Do NOT say you cannot detect an instruction — the INSTRUCTION above IS the instruction.';
        // Re-apply language preservation for non-translate freeform
        systemPrompt += '\n\nIMPORTANT: You MUST respond in the same language as the input text. If the input is in Spanish, respond in Spanish. If the input is in French, respond in French. Do NOT translate to English unless the input is already in English.';
    }

    // Step 6b: Append the user's full spoken transcription to the system prompt.
    // The keyword-matched intent provides structured guidance, but the user's
    // actual words may express a different or more nuanced request (e.g., "formato
    // de prompt" matches "formal" intent but the user wants prompt engineering).
    // We pass the full transcription (not just parsed instruction tokens) so the
    // LLM sees complete context and can adjust accordingly.
    if (rawText && routeResult.intent !== 'freeform') {
        systemPrompt += `\n\nThe user's full spoken command was: "${rawText}". If this command suggests a different intent than the one described above, prioritize what the user actually asked for.`;
    }

    const temperature = template.temperature;

    // Step 7: Build user content — combine speech and clipboard
    const { text: userContent, wasTruncated } = buildUserContent(
        routeResult.content,
        clipboardText,
        routeResult.intent
    );

    // Step 8: Build messages array
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
    ];

    // Debug: log the exact prompt sent to LLM for troubleshooting intent issues
    console.log('[pipeline] Intent:', routeResult.intent, '| editorInstruction:', options.editorInstruction || '(none)');
    console.log('[pipeline] System prompt:', systemPrompt.slice(0, 200) + (systemPrompt.length > 200 ? '...' : ''));
    console.log('[pipeline] User content:', userContent.slice(0, 200) + (userContent.length > 200 ? '...' : ''));

    // Step 9: Run inference with timeout fallback
    let llmOutput;
    let timedOut = false;

    let timeoutId = null;
    try {
        llmOutput = await Promise.race([
            llamaService.infer(routeResult.intent, messages, temperature),
            new Promise((_, reject) =>
                timeoutId = setTimeout(
                    () => reject(new Error('PIPELINE_TIMEOUT')),
                    PIPELINE_TIMEOUT_MS
                )
            ),
        ]);
    } catch (err) {
        if (err.message === 'PIPELINE_TIMEOUT') {
            console.warn('[pipeline] LLM inference timed out after', PIPELINE_TIMEOUT_MS, 'ms — falling back to raw text');
            llmOutput = rawText;
            timedOut = true;
        } else {
            throw err;
        }
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }

    // Step 10: Sanitize LLM output
    const sanitized = sanitizeOutput(llmOutput, rawText);

    // Step 11: Append truncation notice if clipboard was truncated
    let finalOutput = sanitized;
    if (wasTruncated) {
        finalOutput = `${sanitized}\n\n[Note: clipboard content was truncated to 4000 characters]`;
    }

    // Step 12: Return PipelineResult
    return {
        output: finalOutput,
        intent: routeResult.intent,
        targetLanguage: routeResult.targetLanguage || null,
        rawTranscription: rawText,
        usedClipboard: !!clipboardText,
        usedWhisperTranslate,
        timedOut,
    };
};

// ─── processRecording ─────────────────────────────────────────────────────────

/**
 * Run the full Whisper → intentRouter → llamaService pipeline.
 *
 * @param {Float32Array|number[]} audioData - raw audio samples (16kHz mono)
 * @param {string|null} [clipboardText=null] - clipboard content captured by main.cjs
 * @param {object} [options={}]
 * @param {string} [options.modelId] - Whisper model ID override
 * @param {string|null} [options.defaultLanguage] - user-configured default language
 * @returns {Promise<PipelineResult>}
 *
 * @typedef {object} PipelineResult
 * @property {string} output - final processed text (LLM output or raw fallback)
 * @property {string|null} intent - detected intent, or null if no wake word
 * @property {string|null} targetLanguage - target language for translate, or null
 * @property {string} rawTranscription - original Whisper transcription text
 * @property {boolean} usedClipboard - true if clipboard content was sent to LLM
 * @property {boolean} usedWhisperTranslate - true if translateToEnglish was used
 * @property {boolean} timedOut - true if LLM call exceeded PIPELINE_TIMEOUT_MS
 */
const processRecording = async (audioData, clipboardText = null, options = {}) => {
    // Step 1: Transcribe audio via Whisper
    const rawResult = await whisperCppService.transcribe(audioData, { modelId: options.modelId });
    const rawText = rawResult.text;

    // Step 2: Route through intentRouter
    const routeResult = intentRouter.route(rawText, options.defaultLanguage || null);

    // Step 3: No wake word → return raw transcription, discard clipboard (CLIP-04)
    if (!routeResult.wakeWordFound) {
        return {
            output: rawText,
            intent: null,
            targetLanguage: null,
            rawTranscription: rawText,
            usedClipboard: false,
            usedWhisperTranslate: false,
            timedOut: false,
        };
    }

    // Step 4: PROC-06 — translate to English without clipboard uses Whisper's native translation
    if (
        routeResult.intent === 'translate' &&
        routeResult.targetLanguage === 'English' &&
        !clipboardText
    ) {
        if (typeof whisperCppService.translateToEnglish === 'function') {
            const translatedResult = await whisperCppService.translateToEnglish(audioData, {
                modelId: options.modelId,
            });
            return {
                output: translatedResult.text,
                intent: 'translate',
                targetLanguage: 'English',
                rawTranscription: rawText,
                usedClipboard: false,
                usedWhisperTranslate: true,
                timedOut: false,
            };
        } else {
            console.warn('[pipeline] translateToEnglish not yet available — falling back to LLM translation');
            // Fall through to LLM path
        }
    }

    // Steps 5-12: prompt template, LLM inference, sanitization, timeout (shared with processTranscribedText)
    return _runLlmPipeline(routeResult, rawText, clipboardText, options, false);
};

// ─── processTranscribedText ───────────────────────────────────────────────────

/**
 * Pipeline entry point for already-transcribed text. Skips Step 1 (Whisper transcription)
 * and starts from intentRouter.route(rawText). Called by main.cjs from the PHASE-5-WIRE
 * site where the renderer has already sent transcribed text (not raw audio bytes).
 *
 * PROC-06 note: the Whisper translate-to-English shortcut (PROC-06) is unavailable here
 * because audioData is not present. When intent=translate and targetLanguage=English with
 * no clipboard, the function falls through to LLM translation — functionally correct but
 * slower than the native Whisper translate path. This is acceptable for Phase 5.
 *
 * @param {string} rawText - already-transcribed text from Whisper (via renderer IPC)
 * @param {string|null} [clipboardText=null] - clipboard content captured by main.cjs
 * @param {object} [options={}]
 * @param {string|null} [options.defaultLanguage] - user-configured default language
 * @returns {Promise<PipelineResult>}
 */
const processTranscribedText = async (rawText, clipboardText = null, options = {}) => {
    let routeResult;

    if (options.routeOverride) {
        // Caller provided a pre-built route result (e.g., LLM hotkey freeform mode)
        routeResult = options.routeOverride;
    } else {
        // Route through intentRouter (equivalent to Step 2 in processRecording)
        routeResult = intentRouter.route(rawText, options.defaultLanguage || null);

        // No wake word → return raw text passthrough, discard clipboard (CLIP-04)
        if (!routeResult.wakeWordFound) {
            return {
                output: rawText,
                intent: null,
                targetLanguage: null,
                rawTranscription: rawText,
                usedClipboard: false,
                usedWhisperTranslate: false,
                timedOut: false,
            };
        }
    }

    // PROC-06 translate-to-English path is NOT available here (no audioData).
    // Fall through to LLM translation regardless — usedWhisperTranslate stays false.

    // Steps 5-12: prompt template, LLM inference, sanitization, timeout (shared with processRecording)
    return _runLlmPipeline(routeResult, rawText, clipboardText, options, false);
};

// ─── INTENT_LABEL_MAP ─────────────────────────────────────────────────────────

/**
 * Maps intent names to human-readable label strings for history badges and step progress.
 * Functions receive optional targetLanguage (or undefined) and return a string.
 * Exported via _internal for reuse in main.cjs.
 */
const INTENT_LABEL_MAP = {
    translate: (lang) => `Translated to ${lang || 'unknown'}`,
    formal: () => 'Made formal',
    professional: () => 'Made professional',
    email: () => 'Formatted as email',
    report: () => 'Formatted as report',
    concise: () => 'Made concise',
    grammar: () => 'Fixed grammar',
    rewrite: () => 'Rewritten',
    analyze: () => 'Analysis',
};

// ─── processChainedText ───────────────────────────────────────────────────────

/**
 * Run sequential multi-intent LLM inference for chained voice commands.
 *
 * Each step's output becomes the next step's input content, implementing
 * the "translate to French and make formal" compound command pattern.
 *
 * Passthrough intents (intent === null) are skipped — content passes unchanged.
 * On partial failure (step > 0): prior result preserved with failure note appended.
 * On step 0 failure: error re-thrown so caller handles it identically to single-intent failure.
 *
 * @param {string} rawText - original transcription (used as rawTranscription and fallback)
 * @param {Array<{wakeWordFound: boolean, intent: string|null, targetLanguage: string|null, content: string, rawInstruction: string}>} routeResults - array from routeChain()
 * @param {string|null} clipboardText - clipboard captured by main.cjs (first step only)
 * @param {object} [options={}]
 * @param {Function} [options.onStepStart] - called as onStepStart(stepIndex, totalSteps, intentLabel) before each step
 * @returns {Promise<ChainedPipelineResult>}
 *
 * @typedef {object} ChainedPipelineResult
 * @property {string} output - final chain output (last successful step)
 * @property {string|null} intent - last intent in chain
 * @property {string|null} targetLanguage - targetLanguage from first translate intent, or null
 * @property {string} rawTranscription - original transcription text
 * @property {boolean} usedClipboard - true if clipboardText was non-empty
 * @property {boolean} usedWhisperTranslate - always false (not available for pre-transcribed text)
 * @property {boolean} timedOut - true if any step timed out
 * @property {boolean} chained - always true (flag for downstream detection)
 * @property {number} chainSteps - total number of routeResults
 * @property {string[]} stepLabels - human-readable label per completed (non-passthrough) step
 */
const processChainedText = async (rawText, routeResults, clipboardText = null, options = {}) => {
    let currentContent = routeResults[0].content;
    const stepLabels = [];
    let anyTimedOut = false;
    let lastSuccessfulContent = currentContent;

    let chainLanguage = null; // Track language from a translate step for downstream preservation

    for (let i = 0; i < routeResults.length; i++) {
        const routeResult = routeResults[i];

        // Notify caller of step start (allows indicator to show "Step 1/2: Translating...")
        if (typeof options.onStepStart === 'function') {
            options.onStepStart(i, routeResults.length, routeResult.intent);
        }

        // Passthrough / dictate intent — skip LLM, content passes unchanged
        if (routeResult.intent === null) {
            continue;
        }

        // If a previous step was translate, append a language preservation hint
        // so the next LLM step doesn't revert to the original language.
        let stepContent = currentContent;
        if (i > 0 && chainLanguage && routeResult.intent !== 'translate') {
            stepContent = currentContent + `\n\n[IMPORTANT: Keep the text in ${chainLanguage}. Do not translate it back to another language.]`;
        }

        // Build synthetic routeResult with updated content from previous step
        const syntheticRouteResult = {
            ...routeResult,
            content: stepContent,
        };

        // Clipboard is only relevant for the first step — subsequent steps work on LLM output
        const stepClipboard = i === 0 ? clipboardText : null;

        try {
            const result = await _runLlmPipeline(syntheticRouteResult, rawText, stepClipboard, options, false);

            if (result.timedOut) {
                anyTimedOut = true;
            }

            currentContent = result.output;
            lastSuccessfulContent = currentContent;

            // Track language from translate steps for downstream preservation
            if (routeResult.intent === 'translate' && routeResult.targetLanguage) {
                chainLanguage = routeResult.targetLanguage;
            }

            // Collect human-readable label using INTENT_LABEL_MAP
            const labelFn = INTENT_LABEL_MAP[routeResult.intent];
            if (labelFn) {
                stepLabels.push(labelFn(routeResult.targetLanguage));
            }
        } catch (stepErr) {
            if (i === 0) {
                // First step failure — re-throw so caller handles like a normal pipeline failure
                throw stepErr;
            }
            // Subsequent step failure — preserve prior result with failure note
            const failureNote = `\n\n[Note: Step ${i + 1} (${routeResult.intent}) failed — showing result of previous step]`;
            return {
                output: lastSuccessfulContent + failureNote,
                intent: routeResults[routeResults.length - 1].intent,
                targetLanguage: routeResults[0].targetLanguage || null,
                rawTranscription: rawText,
                usedClipboard: !!clipboardText,
                usedWhisperTranslate: false,
                timedOut: anyTimedOut,
                chained: true,
                chainSteps: routeResults.length,
                stepLabels,
            };
        }
    }

    return {
        output: currentContent,
        intent: routeResults[routeResults.length - 1].intent,
        targetLanguage: routeResults[0].targetLanguage || null,
        rawTranscription: rawText,
        usedClipboard: !!clipboardText,
        usedWhisperTranslate: false,
        timedOut: anyTimedOut,
        chained: true,
        chainSteps: routeResults.length,
        stepLabels,
    };
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    processRecording,
    processTranscribedText,
    processChainedText,
    _internal: {
        buildUserContent,
        sanitizeOutput,
        INTENT_LABEL_MAP,
    },
};
