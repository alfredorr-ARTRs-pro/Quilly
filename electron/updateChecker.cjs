'use strict';

// Update checker for the GitHub-installer build. Asks the public repo's
// "latest release" endpoint (drafts and pre-releases are excluded by GitHub)
// and compares its tag with the running version. The Microsoft Store build
// never calls this — Store updates are delivered by Windows.

const RELEASES_API = 'https://api.github.com/repos/alfredorr-ARTRs-pro/Quilly/releases/latest';
const RELEASE_PAGE_PREFIX = 'https://github.com/alfredorr-ARTRs-pro/Quilly/releases/';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Parse "v1.8.0" / "1.8.0" into [1, 8, 0]; null when it isn't a plain x.y.z version. */
function parseVersion(tag) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(tag || '').trim());
    return match ? match.slice(1).map(Number) : null;
}

/** >0 when a is newer than b, <0 when older, 0 when equal. Unparseable → 0. */
function compareVersions(a, b) {
    const va = parseVersion(a);
    const vb = parseVersion(b);
    if (!va || !vb) return 0;
    for (let i = 0; i < 3; i++) {
        if (va[i] !== vb[i]) return va[i] - vb[i];
    }
    return 0;
}

/**
 * @returns {Promise<{status: 'available'|'up-to-date'|'error', currentVersion: string,
 *   latestVersion?: string, url?: string, error?: string}>}
 */
async function checkForUpdates({ currentVersion, fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
    try {
        const response = await fetchImpl(RELEASES_API, {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Quilly-update-check' },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
            return { status: 'error', currentVersion, error: `GitHub responded ${response.status}` };
        }
        const release = await response.json();
        const latestVersion = String(release?.tag_name || '').replace(/^v/, '');
        if (!parseVersion(latestVersion)) {
            return { status: 'error', currentVersion, error: 'Unrecognised release version' };
        }
        // Only ever hand the renderer / shell.openExternal a link to our own releases.
        const url = typeof release.html_url === 'string' && release.html_url.startsWith(RELEASE_PAGE_PREFIX)
            ? release.html_url
            : `${RELEASE_PAGE_PREFIX}latest`;
        const status = compareVersions(latestVersion, currentVersion) > 0 ? 'available' : 'up-to-date';
        return { status, currentVersion, latestVersion, url };
    } catch (err) {
        return { status: 'error', currentVersion, error: err?.message || String(err) };
    }
}

/** True when the last automatic check is older than a day (or never happened). */
function isCheckDue(lastCheckedAt, now = Date.now()) {
    return !Number.isFinite(lastCheckedAt) || now - lastCheckedAt >= CHECK_INTERVAL_MS;
}

module.exports = { checkForUpdates, compareVersions, parseVersion, isCheckDue, RELEASES_API, CHECK_INTERVAL_MS };
