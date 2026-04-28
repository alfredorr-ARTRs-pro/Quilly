'use strict';

// intentRouter.cjs — wake word detection and intent classification
//
// Receives Whisper transcription text, detects the "Quilly" wake word using
// Levenshtein distance 2 with an exclusion list, classifies intent via multilingual
// keyword tables, extracts the target language, and separates the spoken instruction
// from the content to be processed.
//
// Public API:
//   route(text, defaultLanguage) → RouteResult
//   routeChain(text, defaultLanguage) → RouteResult[] (multi-intent chain detection)
//
// Internal API (exposed via _internal for testing):
//   tokenize(text) → string[]
//   levenshtein(a, b) → number
//   findWakeWord(tokens) → number (index or -1)
//   splitContentFromInstruction(tokens, wakeIdx, intentIdx, instructionEndIdx, excludeIndices?) → { content, instruction }
//   findIntentKeyword(tokens, startIdx) → { intent, keywordIdx }
//   extractLanguage(tokens, afterIdx, defaultLanguage) → { language, tokensConsumed, langStartIdx }
//
// RouteResult shape:
//   {
//     wakeWordFound: boolean,
//     intent: 'translate'|'formal'|'professional'|'email'|'report'|'concise'|'grammar'|'rewrite'|'analyze'|'freeform'|null,
//     targetLanguage: string|null,
//     content: string,
//     rawInstruction: string,
//   }

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_WAKE_WORD = 'quilly';
const DEFAULT_WAKE_DISTANCE = 2;

/** Exact Whisper mishearing aliases — bypass fuzzy check entirely */
const DEFAULT_WAKE_ALIASES = ['quilly', 'quilley', 'quillie', 'killy', 'keely'];

/**
 * Common English words within Levenshtein distance 2 of "quilly".
 * These must be rejected to avoid false positives in everyday speech.
 */
const DEFAULT_WAKE_EXCLUSIONS = new Set([
    'chilly', 'hilly', 'filly', 'silly', 'willy', 'billy', 'dilly',
    'tilly', 'philly', 'quickly', 'grilly', 'frilly',
    // _ully pattern: levenshtein("_ully", "quilly") = 2
    'fully', 'bully', 'gully', 'dully', 'sully',
    // Other common words within distance 2
    'guilty', 'quietly', 'equally', 'quilt', 'quilts',
]);

// Mutable runtime state — updated via setWakeWord()
let _wakeWord = DEFAULT_WAKE_WORD;
let _wakeDistance = DEFAULT_WAKE_DISTANCE;
let _wakeAliases = DEFAULT_WAKE_ALIASES;
let _wakeExclusions = DEFAULT_WAKE_EXCLUSIONS;

/**
 * Update the active wake word at runtime. Called by main.cjs on startup
 * and when the setting changes.
 *
 * When word is 'quilly', the Quilly-specific aliases and exclusion list
 * are restored. For any other word, only Levenshtein fuzzy matching is used.
 */
const setWakeWord = (word) => {
    const normalized = (word || 'quilly').trim().toLowerCase();
    _wakeWord = normalized;

    if (normalized === DEFAULT_WAKE_WORD) {
        _wakeDistance = DEFAULT_WAKE_DISTANCE;
        _wakeAliases = DEFAULT_WAKE_ALIASES;
        _wakeExclusions = DEFAULT_WAKE_EXCLUSIONS;
    } else {
        _wakeDistance = DEFAULT_WAKE_DISTANCE;
        _wakeAliases = [normalized];
        _wakeExclusions = new Set();
    }
};

/**
 * Intent keyword table. Array of { intent, keywords[] } entries.
 * First match wins — order matters for disambiguation.
 */
const INTENT_TABLE = [
    {
        intent: 'translate',
        keywords: [
            // English
            'translate', 'translation',
            // Spanish
            'traduce', 'traducir', 'tradución',
            // French
            'traduire', 'traduction',
            // German
            'übersetzen', 'übersetzung',
            // Italian
            'tradurre', 'traduzione',
            // Portuguese
            'traduzir', 'tradução',
            // Russian
            'перевести', 'перевод',
            // Japanese
            '翻訳', '翻訳して',
            // Korean
            '번역', '번역해',
            // Chinese
            '翻译',
        ],
    },
    {
        intent: 'professional',
        keywords: [
            'professional', 'professionalize',
            'profesional',     // Spanish
            'professionell',   // German
            'professionnel',   // French
        ],
    },
    {
        intent: 'email',
        keywords: [
            'email', 'e-mail', 'mail',
            'correo',          // Spanish
            'courriel',        // French
        ],
    },
    {
        intent: 'report',
        keywords: [
            'report', 'memo',
            'informe', 'reporte', // Spanish
            'bericht',         // German
            'rapport',         // French
        ],
    },
    {
        intent: 'formal',
        keywords: [
            // English
            'formal', 'formalize',
            'reformat', 'format', 'polish',
            // Spanish
            'formato', 'formatear', 'formalizar',
            // German
            'formell', 'formatieren',
            // French/Danish
            'formel', 'formater',
            // Italian
            'formattare',
            // Portuguese
            'formatar',
            // Russian
            'формальный',
        ],
    },
    {
        intent: 'grammar',
        keywords: [
            // English
            'grammar', 'proofread', 'spell', 'spelling', 'fix', 'correct',
            // Spanish
            'gramática', 'ortografía', 'corregir', 'corrección',
        ],
    },
    {
        intent: 'rewrite',
        keywords: [
            // English
            'rewrite', 'rephrase', 'paraphrase', 'rework', 'revise', 'edit',
            // Spanish
            'reescribir', 'reformular', 'editar', 'redactar',
            // German
            'umschreiben',
            // French
            'reformuler',
            // Italian
            'riscrivere',
            // Portuguese
            'reescrever',
        ],
    },
    {
        intent: 'concise',
        keywords: [
            // English
            'concise', 'shorten', 'compress', 'brief', 'shorter',
            // Spanish
            'resumir', 'acortar', 'abreviar', 'breve',
        ],
    },
    {
        intent: 'analyze',
        keywords: [
            // English
            'analyze', 'analyse', 'analysis', 'summarize', 'summarise',
            'summary', 'explain', 'review',
            // Spanish
            'analizar', 'análisis', 'explicar', 'revisar',
            // German
            'analysieren',
            // French
            'analyser',
        ],
    },
];

/**
 * Language name lookup table. Maps lowercase English names and native endonyms
 * to canonical English language names. Keys are always lowercase.
 */
const LANGUAGE_NAMES = {
    // English names
    'english': 'English',
    'french': 'French',
    'german': 'German',
    'spanish': 'Spanish',
    'italian': 'Italian',
    'portuguese': 'Portuguese',
    'russian': 'Russian',
    'japanese': 'Japanese',
    'korean': 'Korean',
    'chinese': 'Chinese',
    'arabic': 'Arabic',
    'dutch': 'Dutch',
    'polish': 'Polish',
    'turkish': 'Turkish',
    'swedish': 'Swedish',
    'norwegian': 'Norwegian',
    'danish': 'Danish',
    'finnish': 'Finnish',
    'greek': 'Greek',
    'hebrew': 'Hebrew',
    'hindi': 'Hindi',
    'thai': 'Thai',
    'vietnamese': 'Vietnamese',
    'indonesian': 'Indonesian',
    'malay': 'Malay',
    'czech': 'Czech',
    'slovak': 'Slovak',
    'hungarian': 'Hungarian',
    'romanian': 'Romanian',
    'ukrainian': 'Ukrainian',
    // Native names (endonyms)
    'français': 'French',
    'deutsch': 'German',
    'español': 'Spanish',
    'italiano': 'Italian',
    'português': 'Portuguese',
    'русский': 'Russian',
    '日本語': 'Japanese',
    '한국어': 'Korean',
    '中文': 'Chinese',
    'العربية': 'Arabic',
    'nederlands': 'Dutch',
    'polski': 'Polish',
    'türkçe': 'Turkish',
    'svenska': 'Swedish',
    'norsk': 'Norwegian',
    'dansk': 'Danish',
    'suomi': 'Finnish',
    'ελληνικά': 'Greek',
    'עברית': 'Hebrew',
    'हिन्दी': 'Hindi',
    'ภาษาไทย': 'Thai',
    // Additional Spanish variant for "japonés" → Japanese
    'japonés': 'Japanese',
    'japonais': 'Japanese',
    'japanisch': 'Japanese',
    // Multi-word native names
    'tiếng việt': 'Vietnamese',
    'bahasa indonesia': 'Indonesian',
    // Additional aliases
    'mandarin': 'Chinese',
    'arabic': 'Arabic',
    'catalan': 'Catalan',
    'catala': 'Catalan',
    'català': 'Catalan',
};

/**
 * BCP-47 language code to canonical English language name.
 * Used to map system locale codes (e.g. "fr" from "fr-FR") to language names.
 */
const LOCALE_CODE_TO_NAME = {
    'en': 'English',
    'fr': 'French',
    'de': 'German',
    'es': 'Spanish',
    'it': 'Italian',
    'pt': 'Portuguese',
    'ru': 'Russian',
    'ja': 'Japanese',
    'ko': 'Korean',
    'zh': 'Chinese',
    'ar': 'Arabic',
    'nl': 'Dutch',
    'pl': 'Polish',
    'tr': 'Turkish',
    'sv': 'Swedish',
    'no': 'Norwegian',
    'da': 'Danish',
    'fi': 'Finnish',
    'el': 'Greek',
    'he': 'Hebrew',
    'hi': 'Hindi',
    'th': 'Thai',
    'vi': 'Vietnamese',
    'id': 'Indonesian',
    'ms': 'Malay',
    'cs': 'Czech',
    'sk': 'Slovak',
    'hu': 'Hungarian',
    'ro': 'Romanian',
    'uk': 'Ukrainian',
};

/**
 * Preposition tokens to skip when extracting language name.
 * Covers prepositions from the major instruction languages.
 */
const PREPOSITIONS = new Set([
    'to', 'in', 'into',     // English
    'en',                   // Spanish/French
    'auf',                  // German
    'à', 'a',              // French/Italian
    'al',                   // Spanish/Italian
    'в',                    // Russian
    'に', 'で',             // Japanese
    'na', 'do', 'po',      // Slavic languages
]);

// ─── tokenize ─────────────────────────────────────────────────────────────────

/**
 * Split text into normalized tokens.
 *
 * - NFC-normalize for Unicode safety (handles composed vs. decomposed chars)
 * - Split on whitespace
 * - Strip leading/trailing non-letter characters using Unicode property escapes (\p{L})
 * - Lowercase
 * - Filter empty tokens
 *
 * @param {string} text
 * @returns {string[]}
 */
const tokenize = (text) =>
    text
        .normalize('NFC')
        .split(/\s+/)
        .map((t) => t.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '').toLowerCase())
        .filter((t) => t.length > 0);

// ─── levenshtein ─────────────────────────────────────────────────────────────

/**
 * Compute Levenshtein edit distance between two strings.
 *
 * Wagner-Fischer 1D array implementation.
 * Swaps a/b so the shorter string is always `a` (memory optimization).
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
const levenshtein = (a, b) => {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    // Swap so a is always shorter (row size = a.length + 1)
    if (a.length > b.length) {
        [a, b] = [b, a];
    }

    const row = Array.from({ length: a.length + 1 }, (_, i) => i);

    for (let i = 1; i <= b.length; i++) {
        let prev = i;
        for (let j = 1; j <= a.length; j++) {
            const val =
                b[i - 1] === a[j - 1]
                    ? row[j - 1]
                    : Math.min(row[j - 1] + 1, Math.min(prev + 1, row[j] + 1));
            row[j - 1] = prev;
            prev = val;
        }
        row[a.length] = prev;
    }

    return row[a.length];
};

// ─── findWakeWord ─────────────────────────────────────────────────────────────

/**
 * Find the first token in `tokens` that matches the wake word.
 *
 * Algorithm per token:
 *   1. Check WAKE_ALIASES exact match → return index immediately
 *   2. Check WAKE_EXCLUSIONS → skip if in set
 *   3. Compute levenshtein(token, WAKE_WORD) → if <= WAKE_DISTANCE, return index
 *
 * @param {string[]} tokens - already lowercased, punctuation-stripped tokens
 * @returns {number} index of wake word token, or -1 if not found
 */
const findWakeWord = (tokens) => {
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];

        // 1. Exact alias match (includes wake word itself)
        if (_wakeAliases.includes(token)) {
            return i;
        }

        // 2. Exclusion list — reject before fuzzy check
        if (_wakeExclusions.has(token)) {
            continue;
        }

        // 3. Fuzzy match via Levenshtein
        if (levenshtein(token, _wakeWord) <= _wakeDistance) {
            return i;
        }
    }

    return -1;
};

// ─── splitContentFromInstruction ─────────────────────────────────────────────

/**
 * Split a token array into instruction and content parts based on wake word position.
 *
 * The instruction span is determined by:
 *   - If intentIdx === -1: instruction is just the wake word token; content is all others
 *   - Otherwise: instruction span is from min(wakeIdx, intentIdx) to instructionEndIdx (inclusive)
 *
 * Content = tokens before instruction span + tokens after instruction span, joined with spaces.
 * Instruction = tokens in the instruction span, joined with spaces.
 *
 * Mid-sentence wake word: content stitches both sides (no tokens are silently discarded).
 *
 * When excludeIndices is provided (a Set of token indices), set-based exclusion is used instead
 * of contiguous span logic. Tokens at excluded indices become the instruction; all others become
 * content. This supports non-contiguous instruction tokens (e.g., wake word + keyword + language
 * tokens when content tokens sit between keyword and language).
 *
 * @param {string[]} tokens
 * @param {number} wakeIdx - index of wake word token
 * @param {number} intentIdx - index of intent keyword token (-1 if no intent found)
 * @param {number} instructionEndIdx - last index of the instruction span
 * @param {Set<number>} [excludeIndices] - optional set of token indices to treat as instruction tokens
 * @returns {{ content: string, instruction: string }}
 */
const splitContentFromInstruction = (tokens, wakeIdx, intentIdx, instructionEndIdx, excludeIndices) => {
    if (excludeIndices) {
        // Set-based exclusion for non-contiguous instruction tokens
        const instructionTokens = [];
        const contentTokens = [];
        for (let i = 0; i < tokens.length; i++) {
            if (excludeIndices.has(i)) {
                instructionTokens.push(tokens[i]);
            } else {
                contentTokens.push(tokens[i]);
            }
        }
        return {
            content: contentTokens.join(' '),
            instruction: instructionTokens.join(' '),
        };
    }

    // Original contiguous-span logic (completely unchanged)
    let spanStart;
    let spanEnd;

    if (intentIdx === -1) {
        // No intent keyword: instruction is just the wake word
        spanStart = wakeIdx;
        spanEnd = wakeIdx;
    } else {
        // Instruction span covers from wake word to intent keyword (and beyond if specified)
        spanStart = Math.min(wakeIdx, intentIdx);
        spanEnd = Math.max(instructionEndIdx, wakeIdx, intentIdx);
    }

    const instructionTokens = tokens.slice(spanStart, spanEnd + 1);
    const beforeTokens = tokens.slice(0, spanStart);
    const afterTokens = tokens.slice(spanEnd + 1);

    const contentParts = [];
    if (beforeTokens.length > 0) contentParts.push(beforeTokens.join(' '));
    if (afterTokens.length > 0) contentParts.push(afterTokens.join(' '));

    return {
        content: contentParts.join(' '),
        instruction: instructionTokens.join(' '),
    };
};

// ─── findIntentKeyword ────────────────────────────────────────────────────────

/**
 * Find the first intent keyword in the token array, starting from startIdx.
 *
 * Scan strategy (per RESEARCH.md Open Question 3):
 *   1. Scan from startIdx to end of tokens
 *   2. If no match, scan from 0 to startIdx as fallback (for content-before-wake patterns)
 *
 * @param {string[]} tokens - already lowercased, punctuation-stripped tokens
 * @param {number} startIdx - start scanning from this index (usually the wake word index)
 * @returns {{ intent: string|null, keywordIdx: number }}
 */
const findIntentKeyword = (tokens, startIdx) => {
    // Build a flat lookup: keyword → intent (for O(1) lookup vs O(n·m) nested scan)
    const keywordMap = new Map();
    for (const entry of INTENT_TABLE) {
        for (const kw of entry.keywords) {
            if (!keywordMap.has(kw)) {
                keywordMap.set(kw, entry.intent);
            }
        }
    }

    // Phase 1: scan from startIdx to end
    for (let i = startIdx; i < tokens.length; i++) {
        const normalized = tokens[i].normalize('NFC');
        if (keywordMap.has(normalized)) {
            return { intent: keywordMap.get(normalized), keywordIdx: i };
        }
    }

    // Phase 2: fallback scan from 0 to startIdx (intent keyword before wake word)
    for (let i = 0; i < startIdx; i++) {
        const normalized = tokens[i].normalize('NFC');
        if (keywordMap.has(normalized)) {
            return { intent: keywordMap.get(normalized), keywordIdx: i };
        }
    }

    return { intent: null, keywordIdx: -1 };
};

// ─── extractLanguage ──────────────────────────────────────────────────────────

/**
 * Extract target language from tokens after the intent keyword.
 *
 * Algorithm (forward scan through ALL remaining tokens):
 *   1. Start scanning from afterIdx + 1.
 *   2. Loop through ALL remaining tokens (not just the first non-preposition position).
 *   3. At each position j:
 *      a. If tokens[j] is a preposition (PREPOSITIONS set):
 *         - Try two-token language lookup: tokens[j+1] + ' ' + tokens[j+2]
 *         - Try single-token language lookup: tokens[j+1]
 *         - If match found: return with langStartIdx = j (the preposition index)
 *      b. If tokens[j] is NOT a preposition:
 *         - Try two-token language lookup: tokens[j] + ' ' + tokens[j+1]
 *         - Try single-token language lookup: tokens[j]
 *         - If match: return with langStartIdx = j (the language name index)
 *      c. If no match at position j, continue to j+1 (skip over content tokens).
 *   4. If no match after full scan: return { language: defaultLanguage ?? null, tokensConsumed: 0, langStartIdx: -1 }.
 *
 * Return shape:
 *   - language: canonical English language name, or defaultLanguage, or null
 *   - tokensConsumed: computed as langEndIdx - afterIdx, where langEndIdx is the index of the last
 *     consumed language token. Preserves backward compatibility with adjacent patterns:
 *     "to french" (afterIdx=0) → tokensConsumed=2; for content-between patterns
 *     "this to french" (afterIdx=0) → tokensConsumed=3.
 *   - langStartIdx: absolute token index where language-related tokens begin (the preposition's
 *     index if a preposition precedes the language, or the language name's own index if no
 *     preposition). Set to -1 when no language is found.
 *
 * @param {string[]} tokens - already lowercased, punctuation-stripped tokens
 * @param {number} afterIdx - the index of the intent keyword
 * @param {string|null} defaultLanguage - fallback when no language extracted
 * @returns {{ language: string|null, tokensConsumed: number, langStartIdx: number }}
 */
const extractLanguage = (tokens, afterIdx, defaultLanguage) => {
    // Scan all tokens after the intent keyword
    for (let j = afterIdx + 1; j < tokens.length; j++) {
        if (PREPOSITIONS.has(tokens[j])) {
            // Case A: tokens[j] is a preposition — look for language in tokens[j+1], tokens[j+2]
            const next1 = tokens[j + 1];
            const next2 = tokens[j + 2];

            // Try two-token language name first (e.g., "bahasa indonesia", "tiếng việt")
            if (next1 !== undefined && next2 !== undefined) {
                const twoToken = `${next1} ${next2}`;
                if (LANGUAGE_NAMES[twoToken] !== undefined) {
                    const langEndIdx = j + 2;
                    return {
                        language: LANGUAGE_NAMES[twoToken],
                        tokensConsumed: langEndIdx - afterIdx,
                        langStartIdx: j,
                    };
                }
            }

            // Try single-token language name
            if (next1 !== undefined && LANGUAGE_NAMES[next1] !== undefined) {
                const langEndIdx = j + 1;
                return {
                    language: LANGUAGE_NAMES[next1],
                    tokensConsumed: langEndIdx - afterIdx,
                    langStartIdx: j,
                };
            }

            // Preposition with no language after it — continue scanning
        } else {
            // Case B: tokens[j] is NOT a preposition — check if it is itself a language name
            const curr = tokens[j];
            const next = tokens[j + 1];

            // Try two-token language name first
            if (next !== undefined) {
                const twoToken = `${curr} ${next}`;
                if (LANGUAGE_NAMES[twoToken] !== undefined) {
                    const langEndIdx = j + 1;
                    return {
                        language: LANGUAGE_NAMES[twoToken],
                        tokensConsumed: langEndIdx - afterIdx,
                        langStartIdx: j,
                    };
                }
            }

            // Try single-token language name
            if (LANGUAGE_NAMES[curr] !== undefined) {
                const langEndIdx = j;
                return {
                    language: LANGUAGE_NAMES[curr],
                    tokensConsumed: langEndIdx - afterIdx,
                    langStartIdx: j,
                };
            }

            // Not a language token — continue scanning (skip over content tokens)
        }
    }

    // No language found in full scan — return fallback with no tokens consumed
    return { language: defaultLanguage ?? null, tokensConsumed: 0, langStartIdx: -1 };
};

// ─── CHAIN_CONJUNCTIONS ───────────────────────────────────────────────────────

/**
 * Single-token conjunctions that can signal a new verb phrase boundary.
 * "and then" (two consecutive tokens) is handled as a special case in routeChain.
 */
const CHAIN_CONJUNCTIONS = new Set(['and', 'then', 'y', 'et', 'und', 'e']);

/**
 * Build the flat keyword map for intent keyword lookup.
 * Separated from findIntentKeyword to avoid rebuilding on every call in routeChain.
 */
const _buildKeywordMap = () => {
    const keywordMap = new Map();
    for (const entry of INTENT_TABLE) {
        for (const kw of entry.keywords) {
            if (!keywordMap.has(kw)) {
                keywordMap.set(kw, entry.intent);
            }
        }
    }
    return keywordMap;
};

// ─── route (Public API) ───────────────────────────────────────────────────────

/**
 * Route a transcription text through wake word detection, intent classification,
 * and language extraction.
 *
 * @param {string} text - raw transcription text from Whisper
 * @param {string|null} [defaultLanguage=null] - user-configured default language
 * @returns {{ wakeWordFound: boolean, intent: string|null, targetLanguage: string|null, content: string, rawInstruction: string }}
 */
const route = (text, defaultLanguage = null) => {
    const tokens = tokenize(text);
    const wakeIdx = findWakeWord(tokens);

    if (wakeIdx === -1) {
        return {
            wakeWordFound: false,
            intent: null,
            targetLanguage: null,
            content: text.trim(),
            rawInstruction: '',
        };
    }

    // Wake word found — classify intent
    const { intent, keywordIdx } = findIntentKeyword(tokens, wakeIdx);

    // No recognized intent keyword — freeform mode: pass everything after wake word to LLM
    if (intent === null) {
        const beforeWake = tokens.slice(0, wakeIdx);
        const afterWake = tokens.slice(wakeIdx + 1);
        const freeformContent = [...beforeWake, ...afterWake].join(' ');
        return {
            wakeWordFound: true,
            intent: 'freeform',
            targetLanguage: null,
            content: freeformContent,
            rawInstruction: freeformContent,
        };
    }

    // Extract target language for translate intent
    let targetLanguage = null;
    let instructionEndIdx = wakeIdx;

    if (intent !== null) {
        instructionEndIdx = keywordIdx;

        if (intent === 'translate') {
            const { language, tokensConsumed, langStartIdx } = extractLanguage(tokens, keywordIdx, defaultLanguage);
            targetLanguage = language;

            if (langStartIdx !== -1) {
                // Language found — build set-based exclusion for non-contiguous instruction tokens
                // (wake word + keyword + language tokens, with content tokens in between preserved)
                const excludeSet = new Set();
                excludeSet.add(wakeIdx);
                excludeSet.add(keywordIdx);
                const langEndIdx = keywordIdx + tokensConsumed;
                for (let k = langStartIdx; k <= langEndIdx; k++) {
                    excludeSet.add(k);
                }

                const { content: c, instruction: inst } = splitContentFromInstruction(
                    tokens, wakeIdx, keywordIdx, instructionEndIdx, excludeSet
                );

                return {
                    wakeWordFound: true,
                    intent,
                    targetLanguage,
                    content: c,
                    rawInstruction: inst,
                };
            }

            // Language not found — fall through to existing contiguous span logic
            instructionEndIdx = keywordIdx + tokensConsumed;
        }
    }

    // Split content from instruction span (contiguous span logic)
    const { content, instruction } = splitContentFromInstruction(
        tokens,
        wakeIdx,
        intent !== null ? keywordIdx : -1,
        instructionEndIdx
    );

    return {
        wakeWordFound: true,
        intent,
        targetLanguage,
        content,
        rawInstruction: instruction,
    };
};

// ─── routeChain (Public API) ──────────────────────────────────────────────────

/**
 * Route a transcription text and detect multiple chained intents separated by
 * conjunction boundaries ("and", "then", "and then", etc.).
 *
 * Returns an array of RouteResult-like objects. Each has the same `content` field
 * (the user's content after stripping all instruction tokens), because each intent
 * in the chain operates on the same base content — or the output of the previous
 * step, which pipeline.cjs handles during execution.
 *
 * @param {string} text - raw transcription text from Whisper
 * @param {string|null} [defaultLanguage=null] - user-configured default language
 * @returns {Array<{ wakeWordFound: boolean, intent: string|null, targetLanguage: string|null, content: string, rawInstruction: string }>}
 */
const routeChain = (text, defaultLanguage = null) => {
    const tokens = tokenize(text);
    const wakeIdx = findWakeWord(tokens);

    // No wake word — delegate to route() unchanged
    if (wakeIdx === -1) {
        return [route(text, defaultLanguage)];
    }

    // Find first intent keyword after wake word
    const { intent: firstIntent, keywordIdx: firstKeywordIdx } = findIntentKeyword(tokens, wakeIdx);

    // No intent found — delegate to route() unchanged
    if (firstIntent === null) {
        return [route(text, defaultLanguage)];
    }

    const keywordMap = _buildKeywordMap();

    // Track all instruction token indices (to compute shared content at the end)
    // Instruction tokens: wake word + all intent keywords + language tokens + conjunction tokens
    const instructionIndices = new Set();
    instructionIndices.add(wakeIdx);
    instructionIndices.add(firstKeywordIdx);

    // Collect results: [{ intent, targetLanguage }]
    const intents = [];

    // Process first intent
    let scanStart = firstKeywordIdx + 1; // Start scanning for conjunctions after the first keyword
    let firstTargetLanguage = null;

    if (firstIntent === 'translate') {
        const { language, langStartIdx, tokensConsumed } = extractLanguage(tokens, firstKeywordIdx, defaultLanguage);
        firstTargetLanguage = language;
        if (langStartIdx !== -1) {
            const langEndIdx = firstKeywordIdx + tokensConsumed;
            for (let k = langStartIdx; k <= langEndIdx; k++) {
                instructionIndices.add(k);
            }
            scanStart = langEndIdx + 1;
        }
    }

    intents.push({ intent: firstIntent, targetLanguage: firstTargetLanguage });

    // Scan for conjunction boundaries — up to 2 more intents (max 3 total)
    let i = scanStart;
    while (i < tokens.length && intents.length < 3) {
        const tok = tokens[i];

        // Check for two-token "and then" conjunction
        const isTwoTokenConj = (tok === 'and' && tokens[i + 1] === 'then');
        const isConjunction = isTwoTokenConj || CHAIN_CONJUNCTIONS.has(tok);

        if (!isConjunction) {
            i++;
            continue;
        }

        // Found a conjunction — determine whether it introduces a new verb phrase
        // (intent boundary) or connects modifiers/targets within the same intent
        // (e.g., "French and Spanish" — no split).
        const conjEnd = isTwoTokenConj ? i + 1 : i; // last index of the conjunction tokens

        // Step 1: Check the next non-preposition token immediately after the conjunction.
        let peekIdx = conjEnd + 1;
        while (peekIdx < tokens.length && PREPOSITIONS.has(tokens[peekIdx])) {
            peekIdx++;
        }

        if (peekIdx >= tokens.length) {
            // Nothing after conjunction — stop scanning
            break;
        }

        const immediateToken = tokens[peekIdx].normalize('NFC');

        // If the immediate token is a language name, this is a noun-phrase conjunction
        // (e.g., "French and Spanish" in a translate chain — connects two language targets).
        // Do NOT split — skip past this conjunction and continue.
        if (LANGUAGE_NAMES[immediateToken] !== undefined) {
            i = conjEnd + 1;
            continue;
        }

        // Step 2: Scan forward from conjEnd+1 to find the next intent keyword.
        // This handles "and make it formal" where the intent keyword ("formal") is
        // not immediately after the conjunction.
        let nextIntentKeywordIdx = -1;
        let nextIntent = null;
        for (let j = conjEnd + 1; j < tokens.length; j++) {
            const jTok = tokens[j].normalize('NFC');
            if (keywordMap.has(jTok)) {
                nextIntentKeywordIdx = j;
                nextIntent = keywordMap.get(jTok);
                break;
            }
        }

        if (nextIntent === null) {
            // No intent keyword found after conjunction — no split
            i = conjEnd + 1;
            continue;
        }

        // New intent boundary found — record conjunction tokens as instruction tokens
        for (let k = i; k <= conjEnd; k++) {
            instructionIndices.add(k);
        }
        // Record the new intent keyword as an instruction token
        instructionIndices.add(nextIntentKeywordIdx);
        const peekIdxFinal = nextIntentKeywordIdx;

        // Compute start for next conjunction scan
        let nextScanStart = peekIdxFinal + 1;
        let nextTargetLanguage = null;

        if (nextIntent === 'translate') {
            const { language, langStartIdx, tokensConsumed } = extractLanguage(tokens, peekIdxFinal, defaultLanguage);
            nextTargetLanguage = language;
            if (langStartIdx !== -1) {
                const langEndIdx = peekIdxFinal + tokensConsumed;
                for (let k = langStartIdx; k <= langEndIdx; k++) {
                    instructionIndices.add(k);
                }
                nextScanStart = langEndIdx + 1;
            }
        }

        intents.push({ intent: nextIntent, targetLanguage: nextTargetLanguage });
        i = nextScanStart;
    }

    // If only 1 intent detected, delegate to route() for identical behavior
    if (intents.length === 1) {
        return [route(text, defaultLanguage)];
    }

    // Compute shared content: all tokens NOT in instructionIndices
    const contentTokens = [];
    const instructionTokens = [];
    for (let k = 0; k < tokens.length; k++) {
        if (instructionIndices.has(k)) {
            instructionTokens.push(tokens[k]);
        } else {
            contentTokens.push(tokens[k]);
        }
    }
    const sharedContent = contentTokens.join(' ');
    const rawInstruction = instructionTokens.join(' ');

    // Build result array — each intent shares the same content
    return intents.map(({ intent, targetLanguage }) => ({
        wakeWordFound: true,
        intent,
        targetLanguage,
        content: sharedContent,
        rawInstruction,
    }));
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    route,
    routeChain,
    setWakeWord,
    _internal: {
        tokenize,
        levenshtein,
        findWakeWord,
        splitContentFromInstruction,
        findIntentKeyword,
        extractLanguage,
        routeChain,
        // Tables exposed for test verification
        INTENT_TABLE,
        LANGUAGE_NAMES,
        LOCALE_CODE_TO_NAME,
        PREPOSITIONS,
        CHAIN_CONJUNCTIONS,
    },
};
