'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { checkForUpdates, compareVersions, parseVersion, isCheckDue, CHECK_INTERVAL_MS } = require('./updateChecker.cjs');

const fakeFetch = (body, { ok = true, status = 200 } = {}) => async () => ({ ok, status, json: async () => body });

describe('parseVersion / compareVersions', () => {
    test('parses tags with and without v prefix', () => {
        assert.deepEqual(parseVersion('v1.8.0'), [1, 8, 0]);
        assert.deepEqual(parseVersion('1.10.2'), [1, 10, 2]);
        assert.equal(parseVersion('v1.8.0-beta.1'), null);
        assert.equal(parseVersion(''), null);
    });

    test('compares numerically, not as strings', () => {
        assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
        assert.ok(compareVersions('v1.7.1', '1.8.0') < 0);
        assert.equal(compareVersions('1.8.0', 'v1.8.0'), 0);
        assert.equal(compareVersions('garbage', '1.0.0'), 0);
    });
});

describe('checkForUpdates', () => {
    test('reports a newer release with its page', async () => {
        const url = 'https://github.com/alfredorr-ARTRs-pro/Quilly/releases/tag/v1.9.0';
        const r = await checkForUpdates({ currentVersion: '1.8.0', fetchImpl: fakeFetch({ tag_name: 'v1.9.0', html_url: url }) });
        assert.deepEqual(r, { status: 'available', currentVersion: '1.8.0', latestVersion: '1.9.0', url });
    });

    test('same or older release is up to date', async () => {
        const same = await checkForUpdates({ currentVersion: '1.8.0', fetchImpl: fakeFetch({ tag_name: 'v1.8.0' }) });
        const older = await checkForUpdates({ currentVersion: '1.8.0', fetchImpl: fakeFetch({ tag_name: 'v1.0.2' }) });
        assert.equal(same.status, 'up-to-date');
        assert.equal(older.status, 'up-to-date');
    });

    test('never passes through a release link outside the Quilly repo', async () => {
        const r = await checkForUpdates({
            currentVersion: '1.8.0',
            fetchImpl: fakeFetch({ tag_name: 'v2.0.0', html_url: 'https://evil.example/download' }),
        });
        assert.equal(r.url, 'https://github.com/alfredorr-ARTRs-pro/Quilly/releases/latest');
    });

    test('HTTP errors, bad tags and network failures become status error', async () => {
        const http = await checkForUpdates({ currentVersion: '1.8.0', fetchImpl: fakeFetch({}, { ok: false, status: 403 }) });
        const tag = await checkForUpdates({ currentVersion: '1.8.0', fetchImpl: fakeFetch({ tag_name: 'nightly' }) });
        const net = await checkForUpdates({ currentVersion: '1.8.0', fetchImpl: async () => { throw new Error('offline'); } });
        assert.equal(http.status, 'error');
        assert.equal(tag.status, 'error');
        assert.deepEqual(net, { status: 'error', currentVersion: '1.8.0', error: 'offline' });
    });
});

describe('isCheckDue', () => {
    test('due when never checked or older than a day', () => {
        const now = 1_000_000_000_000;
        assert.equal(isCheckDue(undefined, now), true);
        assert.equal(isCheckDue(now - CHECK_INTERVAL_MS, now), true);
        assert.equal(isCheckDue(now - 1000, now), false);
    });
});
