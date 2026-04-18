import os from 'node:os';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const GPU_CACHE_TTL_MS = 450;
const APP_GPU_HOLD_MS = 1600;

let gpuCache = {
  sampledAt: 0,
  value: null,
  promise: null
};

let fallbackCpuSample = {
  at: process.hrtime.bigint(),
  usage: process.cpuUsage()
};

let appGpuSample = {
  lastActiveAt: 0,
  lastUsagePercent: 0
};

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function parseProcessRow(line) {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s*(.*)$/);
  if (!match) return null;
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    cpuPercent: Number(match[3]),
    rssKb: Number(match[4]),
    command: match[5] || ''
  };
}

function descendantPids(rows, rootPid) {
  const byParent = new Map();
  for (const row of rows) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row.pid);
  }

  const selected = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    for (const childPid of byParent.get(pid) || []) {
      if (selected.has(childPid)) continue;
      selected.add(childPid);
      queue.push(childPid);
    }
  }
  return selected;
}

function fallbackCpuPercent() {
  const now = process.hrtime.bigint();
  const usage = process.cpuUsage();
  const elapsedMicros = Number(now - fallbackCpuSample.at) / 1000;
  const usedMicros = (usage.user - fallbackCpuSample.usage.user) + (usage.system - fallbackCpuSample.usage.system);
  fallbackCpuSample = { at: now, usage };
  if (elapsedMicros <= 0) return 0;
  return Math.max(0, usedMicros / elapsedMicros * 100);
}

async function readProcessTreeStats(rootPid = process.pid) {
  try {
    const { stdout } = await execFile('/bin/ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,comm='], {
      timeout: 800,
      maxBuffer: 1024 * 1024
    });
    const rows = stdout
      .split('\n')
      .map(parseProcessRow)
      .filter(Boolean);
    const selected = descendantPids(rows, rootPid);
    const selectedRows = rows.filter((row) => selected.has(row.pid));
    if (!selectedRows.length) throw new Error('backend process was not listed by ps');

    return {
      cpuPercent: selectedRows.reduce((total, row) => total + (Number.isFinite(row.cpuPercent) ? row.cpuPercent : 0), 0),
      rssBytes: selectedRows.reduce((total, row) => total + (Number.isFinite(row.rssKb) ? row.rssKb * 1024 : 0), 0),
      processCount: selectedRows.length,
      pids: selectedRows.map((row) => row.pid)
    };
  } catch {
    return {
      cpuPercent: fallbackCpuPercent(),
      rssBytes: process.memoryUsage().rss,
      processCount: 1,
      pids: [rootPid]
    };
  }
}

function collectNamedPercent(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`"${escaped}"\\s*=\\s*([\\d.]+)`, 'g');
  const values = [];
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

function parseLastSubmissionPid(text) {
  const match = text.match(/"fLastSubmissionPID"\s*=\s*(\d+)/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function parseGpuUtilization(text) {
  const deviceValues = collectNamedPercent(text, 'Device Utilization %');
  if (deviceValues.length) return clampPercent(Math.max(...deviceValues));

  const rendererValues = collectNamedPercent(text, 'Renderer Utilization %');
  const tilerValues = collectNamedPercent(text, 'Tiler Utilization %');
  const values = [...rendererValues, ...tilerValues];
  return values.length ? clampPercent(Math.max(...values)) : null;
}

function parseGpuSnapshot(text) {
  const usagePercent = parseGpuUtilization(text);
  return {
    available: usagePercent != null,
    usagePercent,
    lastSubmissionPid: parseLastSubmissionPid(text),
    source: usagePercent != null ? 'ioreg' : null
  };
}

async function readGpuSnapshot() {
  const now = Date.now();
  if (gpuCache.value && now - gpuCache.sampledAt < GPU_CACHE_TTL_MS) {
    return gpuCache.value;
  }
  if (gpuCache.promise) return gpuCache.promise;

  gpuCache.promise = (async () => {
    if (process.platform !== 'darwin') {
      return {
        available: false,
        usagePercent: null,
        source: null
      };
    }

    try {
      const { stdout } = await execFile('/usr/sbin/ioreg', ['-r', '-d', '1', '-w0', '-c', 'IOAccelerator'], {
        timeout: 900,
        maxBuffer: 4 * 1024 * 1024
      });
      return parseGpuSnapshot(stdout);
    } catch {
      return {
        available: false,
        usagePercent: null,
        lastSubmissionPid: null,
        source: null
      };
    }
  })();

  try {
    gpuCache.value = await gpuCache.promise;
    gpuCache.sampledAt = Date.now();
    return gpuCache.value;
  } finally {
    gpuCache.promise = null;
  }
}

async function readGpuStats(appPids = []) {
  const snapshot = await readGpuSnapshot();
  if (!snapshot.available) return snapshot;

  const pids = new Set(appPids);
  const appIsSubmitting = snapshot.lastSubmissionPid != null && pids.has(snapshot.lastSubmissionPid);
  const now = Date.now();
  let targetPercent = 0;

  if (appIsSubmitting) {
    targetPercent = snapshot.usagePercent;
    appGpuSample.lastActiveAt = now;
    appGpuSample.lastUsagePercent = targetPercent;
  } else if (now - appGpuSample.lastActiveAt <= APP_GPU_HOLD_MS) {
    targetPercent = appGpuSample.lastUsagePercent;
  }

  return {
    available: true,
    usagePercent: Number(clampPercent(targetPercent).toFixed(1)),
    rawUsagePercent: appIsSubmitting ? snapshot.usagePercent : 0,
    overallUsagePercent: snapshot.usagePercent,
    activePid: snapshot.lastSubmissionPid,
    lastAppActiveMsAgo: appGpuSample.lastActiveAt ? now - appGpuSample.lastActiveAt : null,
    source: snapshot.source,
    scope: 'app_process_tree'
  };
}

export async function readSystemStats({ backend } = {}) {
  const processTree = await readProcessTreeStats();
  const gpu = await readGpuStats(processTree.pids);
  const memory = process.memoryUsage();

  return {
    timestamp: new Date().toISOString(),
    backend: backend || {
      id: 'unknown',
      label: 'Unknown'
    },
    cpu: {
      usagePercent: Number(processTree.cpuPercent.toFixed(1))
    },
    ram: {
      rssBytes: processTree.rssBytes,
      heapUsedBytes: memory.heapUsed,
      totalSystemBytes: os.totalmem()
    },
    gpu,
    process: {
      pid: process.pid,
      processCount: processTree.processCount,
      pids: processTree.pids
    }
  };
}
