// Multi-vendor GPU detection for Quilly
// Detects NVIDIA (via nvidia-smi), AMD, and Intel GPUs (via wmic)
const { execFile } = require('child_process');

const TIMEOUT_MS = 5000;

let cachedResult = null;

/**
 * Run a command with a timeout, returning stdout or null on failure.
 */
const run = (cmd, args) =>
    new Promise((resolve) => {
        try {
            execFile(cmd, args, { timeout: TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
                resolve(err ? null : stdout);
            });
        } catch {
            resolve(null);
        }
    });

/**
 * Detect vendor from GPU name string.
 */
const vendorFromName = (name) => {
    const n = name.toLowerCase();
    if (n.includes('nvidia') || n.includes('geforce') || n.includes('quadro') || n.includes('tesla')) return 'nvidia';
    if (n.includes('amd') || n.includes('radeon') || n.includes('firepro')) return 'amd';
    if (n.includes('intel') || n.includes('iris') || n.includes('uhd graphics') || n.includes('hd graphics')) return 'intel';
    return 'unknown';
};

/**
 * List all GPUs via wmic (works on every Windows system).
 * Returns [{name, vendor, vramMB}]
 */
const detectViaWmic = async () => {
    const out = await run('wmic', [
        'path', 'win32_VideoController', 'get', 'Name,AdapterRAM', '/format:csv',
    ]);
    if (!out) return [];

    const gpus = [];
    const lines = out.trim().split(/\r?\n/).filter(Boolean);
    // First line is header: Node,AdapterRAM,Name
    for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',');
        if (parts.length < 3) continue;
        const adapterRAM = parseInt(parts[1], 10);
        const name = parts.slice(2).join(',').trim();
        if (!name) continue;
        // Filter out virtual/remote display adapters
        if (/remote|virtual|basic display|microsoft/i.test(name)) continue;
        gpus.push({
            name,
            vendor: vendorFromName(name),
            vramMB: adapterRAM > 0 ? Math.round(adapterRAM / 1024 / 1024) : null,
        });
    }
    return gpus;
};

/**
 * Get NVIDIA-specific details via nvidia-smi.
 * Returns {gpuName, cudaVersion, cudaMajor, driverVersion, vramMB} or null.
 */
const detectNvidia = async () => {
    // nvidia-smi prints the CUDA version in its header output.
    // Running without --query gives us the full table including CUDA version.
    // But the query format is cleaner for structured data.
    // Strategy: run both a header call (for CUDA version) and a CSV query.

    // 1. Get CUDA version from the default output header
    const headerOut = await run('nvidia-smi', []);
    let cudaVersion = null;
    if (headerOut) {
        const match = headerOut.match(/CUDA Version:\s*([\d.]+)/);
        if (match) cudaVersion = match[1];
    }

    // 2. Get structured GPU info
    const csvOut = await run('nvidia-smi', [
        '--query-gpu=name,driver_version,memory.total',
        '--format=csv,noheader,nounits',
    ]);
    if (!csvOut) return null;

    const line = csvOut.trim().split(/\r?\n/)[0]; // First GPU
    if (!line) return null;

    const parts = line.split(',').map(s => s.trim());
    if (parts.length < 3) return null;

    const cudaMajor = cudaVersion ? parseInt(cudaVersion.split('.')[0], 10) : null;

    return {
        gpuName: parts[0],
        cudaVersion,
        cudaMajor,
        driverVersion: parts[1],
        vramMB: parseInt(parts[2], 10) || null,
    };
};

/**
 * Choose the best whisper.cpp backend based on detected hardware.
 */
const recommend = (gpus, nvidia) => {
    if (nvidia && nvidia.cudaMajor) {
        if (nvidia.cudaMajor >= 12) return 'cuda12';
        if (nvidia.cudaMajor >= 11) return 'cuda11';
    }
    // NVIDIA present but CUDA too old, or AMD/Intel detected → CPU accel
    // (Vulkan builds not yet available in official releases)
    return 'openblas';
};

/**
 * Build a human-readable summary line.
 */
const buildSummary = (gpus, nvidia) => {
    if (nvidia) {
        const parts = [nvidia.gpuName];
        if (nvidia.cudaVersion) parts.push(`CUDA ${nvidia.cudaVersion}`);
        if (nvidia.vramMB) parts.push(`${(nvidia.vramMB / 1024).toFixed(0)} GB VRAM`);
        return parts.join(' \u00b7 '); // middle dot
    }
    const gpu = gpus.find(g => g.vendor !== 'unknown');
    if (gpu) {
        const parts = [gpu.name];
        if (gpu.vramMB) parts.push(`${(gpu.vramMB / 1024).toFixed(0)} GB VRAM`);
        return parts.join(' \u00b7 ');
    }
    return 'No dedicated GPU detected';
};

/**
 * Detect all GPUs and recommend the best whisper.cpp backend.
 * Result is cached for the session (hardware doesn't change at runtime).
 */
const detectGpu = async () => {
    if (cachedResult) return cachedResult;

    console.log('[gpuDetector] Scanning for GPUs...');

    // Run both detection methods in parallel
    const [gpus, nvidia] = await Promise.all([
        detectViaWmic(),
        detectNvidia(),
    ]);

    // If nvidia-smi gave us a GPU name but wmic didn't list it, add it
    if (nvidia && !gpus.some(g => g.vendor === 'nvidia')) {
        gpus.unshift({
            name: nvidia.gpuName,
            vendor: 'nvidia',
            vramMB: nvidia.vramMB,
        });
    }

    // Update NVIDIA GPU in the wmic list with accurate VRAM from nvidia-smi
    if (nvidia) {
        const nvidiaGpu = gpus.find(g => g.vendor === 'nvidia');
        if (nvidiaGpu && nvidia.vramMB) {
            nvidiaGpu.vramMB = nvidia.vramMB;
        }
    }

    const result = {
        gpus,
        nvidia: nvidia ? {
            cudaVersion: nvidia.cudaVersion,
            cudaMajor: nvidia.cudaMajor,
            driverVersion: nvidia.driverVersion,
        } : null,
        recommended: recommend(gpus, nvidia),
        summary: buildSummary(gpus, nvidia),
    };

    console.log(`[gpuDetector] Found ${gpus.length} GPU(s): ${result.summary}`);
    console.log(`[gpuDetector] Recommended backend: ${result.recommended}`);

    cachedResult = result;
    return result;
};

/**
 * Clear the cached result (useful for testing or after driver updates).
 */
const clearCache = () => { cachedResult = null; };

module.exports = { detectGpu, clearCache };
