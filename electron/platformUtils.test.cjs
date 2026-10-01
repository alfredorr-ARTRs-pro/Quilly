'use strict';

// Tests for electron/platformUtils.cjs — the cross-platform primitives layer.
// Uses the createPlatformUtils factory with injected fakes so every platform's
// behavior is testable regardless of the OS running the suite.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createPlatformUtils } = require('./platformUtils.cjs');

// ─── Fakes ────────────────────────────────────────────────────────────────────

// Records execFile calls; behavior configured per-test.
const makeExecFileFake = () => {
    const calls = [];
    const fake = (cmd, args, opts, cb) => {
        calls.push({ cmd, args, opts });
        const result = fake.nextResult || { err: null, stdout: '', stderr: '' };
        process.nextTick(() => cb(result.err, result.stdout, result.stderr));
    };
    fake.calls = calls;
    fake.nextResult = null;
    return fake;
};

const makeKillFake = () => {
    const calls = [];
    const fake = (pid, signal) => {
        calls.push({ pid, signal });
        if (fake.throwCode) {
            const err = new Error(fake.throwCode);
            err.code = fake.throwCode;
            throw err;
        }
        return true;
    };
    fake.calls = calls;
    fake.throwCode = null;
    return fake;
};

let execFileFake;
let killFake;

const utilsFor = (platform) => createPlatformUtils({
    platform,
    execFileImpl: execFileFake,
    killImpl: killFake,
});

beforeEach(() => {
    execFileFake = makeExecFileFake();
    killFake = makeKillFake();
});

// ─── killPid ──────────────────────────────────────────────────────────────────

describe('killPid', () => {
    test('win32 uses taskkill /F /PID', async () => {
        await utilsFor('win32').killPid(123);
        assert.strictEqual(execFileFake.calls.length, 1);
        assert.strictEqual(execFileFake.calls[0].cmd, 'taskkill');
        assert.deepStrictEqual(execFileFake.calls[0].args, ['/F', '/PID', '123']);
        assert.strictEqual(killFake.calls.length, 0);
    });

    test('win32 resolves even when taskkill errors (already dead)', async () => {
        execFileFake.nextResult = { err: new Error('exit 1'), stdout: '', stderr: '' };
        await utilsFor('win32').killPid(123); // must not reject
    });

    test('darwin uses process.kill with SIGKILL, no subprocess', async () => {
        await utilsFor('darwin').killPid(456);
        assert.deepStrictEqual(killFake.calls, [{ pid: 456, signal: 'SIGKILL' }]);
        assert.strictEqual(execFileFake.calls.length, 0);
    });

    test('darwin resolves on ESRCH (already dead)', async () => {
        killFake.throwCode = 'ESRCH';
        await utilsFor('darwin').killPid(456); // must not reject
    });

    test('invalid pid resolves without doing anything', async () => {
        await utilsFor('darwin').killPid(0);
        await utilsFor('win32').killPid(-1);
        assert.strictEqual(killFake.calls.length, 0);
        assert.strictEqual(execFileFake.calls.length, 0);
    });
});

// ─── isPidAlive ───────────────────────────────────────────────────────────────

describe('isPidAlive', () => {
    test('win32 queries tasklist and matches PID in stdout', async () => {
        execFileFake.nextResult = { err: null, stdout: 'llama-server.exe  123  Console', stderr: '' };
        const alive = await utilsFor('win32').isPidAlive(123);
        assert.strictEqual(alive, true);
        assert.strictEqual(execFileFake.calls[0].cmd, 'tasklist');
        assert.deepStrictEqual(execFileFake.calls[0].args, ['/FI', 'PID eq 123', '/NH']);
    });

    test('win32 returns false when PID absent from stdout', async () => {
        execFileFake.nextResult = { err: null, stdout: 'INFO: No tasks are running', stderr: '' };
        assert.strictEqual(await utilsFor('win32').isPidAlive(123), false);
    });

    test('darwin returns true when signal 0 succeeds', async () => {
        assert.strictEqual(await utilsFor('darwin').isPidAlive(456), true);
        assert.deepStrictEqual(killFake.calls, [{ pid: 456, signal: 0 }]);
    });

    test('darwin returns false on ESRCH', async () => {
        killFake.throwCode = 'ESRCH';
        assert.strictEqual(await utilsFor('darwin').isPidAlive(456), false);
    });

    test('darwin returns true on EPERM (alive, not ours)', async () => {
        killFake.throwCode = 'EPERM';
        assert.strictEqual(await utilsFor('darwin').isPidAlive(456), true);
    });

    test('pid <= 0 is false on both platforms', async () => {
        assert.strictEqual(await utilsFor('win32').isPidAlive(0), false);
        assert.strictEqual(await utilsFor('darwin').isPidAlive(-5), false);
    });
});

// ─── extractArchive ───────────────────────────────────────────────────────────

describe('extractArchive', () => {
    test('win32 zip uses PowerShell Expand-Archive with quoted paths', async () => {
        await utilsFor('win32').extractArchive('C:\\a b\\x.zip', 'C:\\dest');
        const call = execFileFake.calls[0];
        assert.strictEqual(call.cmd, 'powershell.exe');
        assert.ok(call.args.includes('-NoProfile'));
        const command = call.args[call.args.length - 1];
        assert.ok(command.includes("Expand-Archive"));
        assert.ok(command.includes("'C:\\a b\\x.zip'"));
        assert.ok(command.includes("'C:\\dest'"));
    });

    test('darwin zip uses ditto -x -k', async () => {
        await utilsFor('darwin').extractArchive('/tmp/x.zip', '/tmp/dest');
        const call = execFileFake.calls[0];
        assert.strictEqual(call.cmd, 'ditto');
        assert.deepStrictEqual(call.args, ['-x', '-k', '/tmp/x.zip', '/tmp/dest']);
    });

    test('darwin tar.gz uses tar -xf -C (auto-detected compression)', async () => {
        await utilsFor('darwin').extractArchive('/tmp/x.tar.gz', '/tmp/dest');
        const call = execFileFake.calls[0];
        assert.strictEqual(call.cmd, 'tar');
        assert.deepStrictEqual(call.args, ['-xf', '/tmp/x.tar.gz', '-C', '/tmp/dest']);
    });

    test('win32 tar.bz2 uses System32 bsdtar (bare "tar" can hit GNU tar via PATH)', async () => {
        await utilsFor('win32').extractArchive('C:\\tmp\\x.tar.bz2', 'C:\\tmp\\dest');
        const call = execFileFake.calls[0];
        const expectedTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
        assert.strictEqual(call.cmd, expectedTar);
        assert.deepStrictEqual(call.args, ['-xf', 'C:\\tmp\\x.tar.bz2', '-C', 'C:\\tmp\\dest']);
    });

    test('rejects with archive name on extraction failure', async () => {
        execFileFake.nextResult = { err: new Error('boom'), stdout: '', stderr: 'bad archive' };
        await assert.rejects(
            utilsFor('darwin').extractArchive('/tmp/x.zip', '/tmp/dest'),
            /x\.zip/
        );
    });
});

// ─── Keystrokes ───────────────────────────────────────────────────────────────

describe('sendCopyKeystroke', () => {
    test('win32 sends ^c via PowerShell SendKeys', async () => {
        await utilsFor('win32').sendCopyKeystroke();
        const call = execFileFake.calls[0];
        assert.strictEqual(call.cmd, 'powershell');
        assert.ok(call.args.join(' ').includes('SendWait("^c")'));
    });

    test('darwin sends cmd+c via osascript System Events', async () => {
        await utilsFor('darwin').sendCopyKeystroke();
        const call = execFileFake.calls[0];
        assert.strictEqual(call.cmd, 'osascript');
        const script = call.args.join(' ');
        assert.ok(script.includes('System Events'));
        assert.ok(script.includes('keystroke "c" using command down'));
    });
});

describe('sendPasteKeystroke', () => {
    test('win32 sends ^v via PowerShell SendKeys', async () => {
        await utilsFor('win32').sendPasteKeystroke();
        const call = execFileFake.calls[0];
        assert.strictEqual(call.cmd, 'powershell');
        assert.ok(call.args.join(' ').includes("SendWait('^v')"));
    });

    test('win32 falls back to WScript.Shell when SendKeys fails', async () => {
        execFileFake.nextResult = { err: new Error('exit 1'), stdout: '', stderr: '' };
        await utilsFor('win32').sendPasteKeystroke();
        assert.strictEqual(execFileFake.calls.length, 2);
        assert.ok(execFileFake.calls[1].args.join(' ').includes('WScript.Shell'));
    });

    test('darwin sends cmd+v via osascript System Events', async () => {
        await utilsFor('darwin').sendPasteKeystroke();
        const call = execFileFake.calls[0];
        assert.strictEqual(call.cmd, 'osascript');
        assert.ok(call.args.join(' ').includes('keystroke "v" using command down'));
    });

    test('linux uses xdotool', async () => {
        await utilsFor('linux').sendPasteKeystroke();
        const call = execFileFake.calls[0];
        assert.strictEqual(call.cmd, 'xdotool');
        assert.deepStrictEqual(call.args, ['key', 'ctrl+v']);
    });
});

// ─── getBinaryName ────────────────────────────────────────────────────────────

describe('getBinaryName', () => {
    test('appends .exe on win32 only', () => {
        assert.strictEqual(utilsFor('win32').getBinaryName('llama-server'), 'llama-server.exe');
        assert.strictEqual(utilsFor('darwin').getBinaryName('llama-server'), 'llama-server');
        assert.strictEqual(utilsFor('linux').getBinaryName('whisper-cli'), 'whisper-cli');
    });
});

// ─── Default instance ─────────────────────────────────────────────────────────

describe('default instance', () => {
    test('module exports bound helpers and platform flags', () => {
        const platformUtils = require('./platformUtils.cjs');
        assert.strictEqual(typeof platformUtils.killPid, 'function');
        assert.strictEqual(typeof platformUtils.isPidAlive, 'function');
        assert.strictEqual(typeof platformUtils.extractArchive, 'function');
        assert.strictEqual(typeof platformUtils.sendCopyKeystroke, 'function');
        assert.strictEqual(typeof platformUtils.sendPasteKeystroke, 'function');
        assert.strictEqual(typeof platformUtils.getBinaryName, 'function');
        assert.strictEqual(platformUtils.isWindows, process.platform === 'win32');
        assert.strictEqual(platformUtils.isMac, process.platform === 'darwin');
    });
});
