'use strict';

// Cross-platform primitives — the ONLY place OS-specific process control,
// archive extraction, and keystroke simulation may live. Windows
// implementations are the pre-macOS-port code moved verbatim (taskkill /
// tasklist / PowerShell), so Windows behavior is unchanged; darwin uses
// POSIX signals, ditto/tar, and osascript System Events.
//
// createPlatformUtils({ platform, execFileImpl, killImpl }) is exported for
// tests; production code uses the default instance bound to process.platform.

const path = require('path');

const createPlatformUtils = ({
    platform = process.platform,
    execFileImpl = null,
    killImpl = null,
} = {}) => {
    const isWindows = platform === 'win32';
    const isMac = platform === 'darwin';

    // child_process is required lazily so tests can inject a fake without the
    // module ever touching the real binary paths.
    const execFile = (...args) => {
        const impl = execFileImpl || require('child_process').execFile;
        return impl(...args);
    };

    const kill = (pid, signal) => {
        const impl = killImpl || process.kill;
        return impl(pid, signal);
    };

    /**
     * Run a command, resolving with { err, stdout, stderr } — never rejects.
     * Callers decide whether an error matters.
     */
    const run = (cmd, args, opts = {}) =>
        new Promise((resolve) => {
            execFile(cmd, args, { windowsHide: true, ...opts }, (err, stdout, stderr) => {
                resolve({ err, stdout: stdout || '', stderr: stderr || '' });
            });
        });

    /**
     * Force-kill a process. Always resolves: "already dead" (taskkill exit 1,
     * POSIX ESRCH) is success from the caller's point of view.
     */
    const killPid = async (pid) => {
        if (!pid || pid <= 0) return;
        if (isWindows) {
            await run('taskkill', ['/F', '/PID', String(pid)]);
            return;
        }
        try {
            kill(pid, 'SIGKILL');
        } catch (err) {
            if (err.code !== 'ESRCH') {
                // EPERM etc. — the process exists but we could not signal it.
                // Callers poll isPidAlive afterwards, so don't throw here either.
                console.warn(`[platformUtils] kill(${pid}) failed: ${err.code || err.message}`);
            }
        }
    };

    /**
     * Check whether a PID refers to a live process.
     * win32: tasklist output contains the PID string iff alive.
     * POSIX: signal 0 probes existence; EPERM means alive but not ours.
     */
    const isPidAlive = async (pid) => {
        if (!pid || pid <= 0) return false;
        if (isWindows) {
            const { err, stdout } = await run('tasklist', ['/FI', `PID eq ${pid}`, '/NH']);
            if (err) return false;
            return stdout.includes(String(pid));
        }
        try {
            kill(pid, 0);
            return true;
        } catch (err) {
            return err.code === 'EPERM';
        }
    };

    /**
     * Extract a .zip or .tar.gz archive into destDir, off the main thread.
     *
     * win32 zip: PowerShell Expand-Archive (adm-zip's extractAllTo blocks the
     * Electron main thread and is pathologically slow on huge entries —
     * observed live 2026-07-02).
     * darwin zip: ditto -x -k (preserves executable bits, unlike some unzip
     * configurations). tar.gz: bsdtar, which refuses absolute/.. entry paths
     * by default.
     *
     * NOTE: zip traversal pre-validation (adm-zip central-directory scan)
     * remains the caller's job — see safeExtractZip in the downloaders.
     */
    const extractArchive = async (archivePath, destDir) => {
        const isTarGz = /\.t(ar\.)?gz$/i.test(archivePath);
        const isTarBz2 = /\.tar\.bz2$/i.test(archivePath);
        let cmd, args;

        if (isTarGz || isTarBz2) {
            // bsdtar (Windows 10+, macOS) auto-detects compression with plain -xf.
            // On Windows, pin the System32 binary: a bare 'tar' can resolve to
            // Git for Windows' GNU tar via PATH, which parses absolute paths
            // like C:\... as remote host:file specs ("Cannot connect to C").
            cmd = isWindows
                ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
                : 'tar';
            args = ['-xf', archivePath, '-C', destDir];
        } else if (isWindows) {
            const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
            cmd = 'powershell.exe';
            args = [
                '-NoProfile', '-NonInteractive', '-Command',
                `$ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath ${psQuote(archivePath)} -DestinationPath ${psQuote(destDir)} -Force`,
            ];
        } else {
            cmd = 'ditto';
            args = ['-x', '-k', archivePath, destDir];
        }

        const { err, stderr } = await run(cmd, args, {
            timeout: 10 * 60 * 1000,
            maxBuffer: 4 * 1024 * 1024,
        });
        if (err) {
            throw new Error(
                `Extraction failed for ${path.basename(archivePath)}: ${(stderr || err.message).slice(0, 400)}`
            );
        }
    };

    /**
     * Simulate the OS "copy" keystroke against the focused window (Ctrl+C / ⌘C).
     * On macOS this requires the app to be trusted under System Settings →
     * Privacy & Security → Accessibility — callers must check
     * systemPreferences.isTrustedAccessibilityClient first.
     */
    const sendCopyKeystroke = async () => {
        if (isWindows) {
            const { err } = await run('powershell', [
                '-NoProfile', '-Command',
                'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^c")',
            ]);
            if (err) throw err;
            return;
        }
        if (isMac) {
            const { err } = await run('osascript', [
                '-e', 'tell application "System Events" to keystroke "c" using command down',
            ]);
            if (err) throw err;
            return;
        }
        const { err } = await run('xdotool', ['key', 'ctrl+c']);
        if (err) throw err;
    };

    /**
     * Simulate the OS "paste" keystroke (Ctrl+V / ⌘V). Same Accessibility
     * requirement on macOS as sendCopyKeystroke. Errors are logged, not
     * thrown — the clipboard is already populated, so the user can always
     * paste manually.
     */
    const sendPasteKeystroke = async () => {
        if (isWindows) {
            const { err } = await run('powershell', [
                '-NoProfile', '-Command',
                "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')",
            ]);
            if (err) {
                console.error('Paste failed:', err);
                // Fallback: WScript.Shell SendKeys (some environments block
                // the System.Windows.Forms path)
                const { err: err2 } = await run('powershell', [
                    '-Command',
                    "$wsh = New-Object -ComObject WScript.Shell; $wsh.SendKeys('^v')",
                ]);
                if (err2) console.error('Fallback paste also failed:', err2);
            } else {
                console.log('Paste executed successfully');
            }
            return;
        }
        if (isMac) {
            const { err } = await run('osascript', [
                '-e', 'tell application "System Events" to keystroke "v" using command down',
            ]);
            if (err) console.error('Paste failed:', err);
            return;
        }
        const { err } = await run('xdotool', ['key', 'ctrl+v']);
        if (err) console.error('Paste failed:', err);
    };

    /** Platform-correct executable name: foo → foo.exe on Windows only. */
    const getBinaryName = (base) => (isWindows ? `${base}.exe` : base);

    return {
        isWindows,
        isMac,
        killPid,
        isPidAlive,
        extractArchive,
        sendCopyKeystroke,
        sendPasteKeystroke,
        getBinaryName,
    };
};

const defaultInstance = createPlatformUtils();

module.exports = {
    ...defaultInstance,
    createPlatformUtils,
};
