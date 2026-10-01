'use strict';

// Shared text sanitation helpers used by both the intent pipeline
// (pipeline.cjs) and the final-cleanup helper (liveLlmService.cjs).
// There must be exactly ONE <think>-stripping implementation: the two modules
// previously carried diverging copies (one case-insensitive, one handling
// close-only remainders), so a Qwen template quirk fixed on one path kept
// pasting raw reasoning on the other.

/**
 * Strip Qwen-family <think> reasoning from model output.
 *
 * Handles every degenerate shape seen in practice, case-insensitively:
 *  - balanced <think>...</think> pairs (possibly several)
 *  - close-only remainders ("reasoning</think>answer" — the chat template
 *    pre-filled the opening tag, or nesting left a trailing "rest</think>")
 *  - unclosed trailing <think> (generation truncated mid-reasoning)
 *
 * Returns the trimmed remainder — possibly '' when the output was reasoning
 * only; callers treat empty output as "fall back to the raw text".
 *
 * @param {string|null|undefined} text
 * @returns {string}
 */
const stripThinkBlocks = (text) => {
    let result = String(text ?? '');

    // Balanced pairs first.
    result = result.replace(/<think>[\s\S]*?<\/think>/gi, '');

    // Close-only remainder: everything up to the last close tag is reasoning.
    const lastClose = result.toLowerCase().lastIndexOf('</think>');
    if (lastClose !== -1) {
        result = result.slice(lastClose + '</think>'.length);
    }

    // Unclosed trailing <think>: drop from the open tag onward.
    const danglingOpen = result.toLowerCase().indexOf('<think>');
    if (danglingOpen !== -1) {
        result = result.slice(0, danglingOpen);
    }

    return result.trim();
};

module.exports = { stripThinkBlocks };
