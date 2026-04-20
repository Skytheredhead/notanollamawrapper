import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer)
  };
}

function isWindows() {
  return process.platform === 'win32';
}

export class NativeSearxngSidecar {
  constructor({
    home,
    url,
    settingsPath,
    settingsTemplatePath,
    setupScript,
    python = 'python3',
    managed = true,
    fetchImpl = fetch,
    spawnImpl = spawn,
    execFileImpl = execFileAsync,
    timeoutMs = 1500,
    setupTimeoutMs = 180000
  }) {
    this.home = home;
    this.url = url;
    this.settingsPath = settingsPath;
    this.settingsTemplatePath = settingsTemplatePath;
    this.setupScript = setupScript;
    this.python = python;
    this.managed = managed;
    this.fetch = fetchImpl;
    this.spawn = spawnImpl;
    this.execFile = execFileImpl;
    this.timeoutMs = timeoutMs;
    this.setupTimeoutMs = setupTimeoutMs;
    this.process = null;
    this.starting = null;
    this.settingUp = null;
    this.lastStatus = null;
    this.logger = null;
  }

  setLogger(logger) {
    this.logger = logger;
  }

  get sourceDir() {
    return path.join(this.home, 'searxng-src');
  }

  get venvDir() {
    return path.join(this.home, 'searxng-venv');
  }

  get venvPython() {
    return path.join(this.venvDir, isWindows() ? 'Scripts/python.exe' : 'bin/python');
  }

  installed() {
    return fs.existsSync(this.venvPython) && fs.existsSync(path.join(this.sourceDir, 'searx', 'webapp.py'));
  }

  async health() {
    const timeout = timeoutSignal(this.timeoutMs);
    try {
      const url = new URL(this.url);
      url.searchParams.set('q', 'naow');
      url.searchParams.set('format', 'json');
      const response = await this.fetch(url, { signal: timeout.signal });
      if (!response.ok) {
        return { ready: false, state: 'unavailable', message: `SearXNG returned HTTP ${response.status}.` };
      }
      return { ready: true, state: 'ready', message: 'Local search is ready.' };
    } catch (error) {
      return {
        ready: false,
        state: this.settingUp ? 'installing' : 'unavailable',
        message: error?.name === 'AbortError' ? 'Local search timed out.' : 'Local search is not available.'
      };
    } finally {
      timeout.clear();
    }
  }

  async setup() {
    if (this.installed()) return { installed: true, message: 'Local search is installed.' };
    if (this.settingUp) return this.settingUp;
    fs.mkdirSync(this.home, { recursive: true });
    this.settingUp = this.execFile(this.python, [
      this.setupScript,
      '--home', this.home,
      '--settings', this.settingsPath,
      '--settings-template', this.settingsTemplatePath
    ], {
      timeout: this.setupTimeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    })
      .then(() => ({ installed: true, message: 'Local search is installed.' }))
      .catch((error) => ({ installed: false, message: error?.message || 'Could not install local search.' }))
      .finally(() => {
        this.settingUp = null;
      });
    return this.settingUp;
  }

  async start() {
    if (!this.managed) return { started: false, message: 'Managed local search is disabled.' };
    if (this.process && !this.process.killed) return { started: true, message: 'Local search is already running.' };
    if (this.starting) return this.starting;

    this.starting = (async () => {
      if (!this.installed()) {
        const setup = await this.setup();
        if (!setup.installed) return { started: false, message: setup.message };
      }

      fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
      const parsedUrl = new URL(this.url);
      const port = parsedUrl.port || '8088';
      const child = this.spawn(this.venvPython, ['searx/webapp.py'], {
        cwd: this.sourceDir,
        env: {
          ...process.env,
          SEARXNG_SETTINGS_PATH: this.settingsPath,
          SEARXNG_BIND_ADDRESS: '127.0.0.1',
          SEARXNG_PORT: port,
          SEARXNG_DEBUG: '0'
        },
        stdio: 'ignore',
        detached: false
      });
      if (typeof child?.on === 'function') {
        child.on('error', (error) => {
          this.logger?.error?.('[search] spawn error', error);
          this.lastStatus = { ready: false, state: 'unavailable', message: error?.message || 'Local search failed to start.' };
          if (this.process === child) this.process = null;
        });
      }
      child.unref?.();
      this.process = child;
      child.once('exit', () => {
        if (this.process === child) this.process = null;
      });
      return { started: true, message: 'Local search is starting.' };
    })().finally(() => {
      this.starting = null;
    });

    return this.starting;
  }

  async stop() {
    if (!this.managed) return { stopped: false, message: 'Managed local search is disabled.' };
    if (!this.process) return { stopped: false, message: 'Local search is not running.' };
    const child = this.process;
    this.process = null;
    child.kill('SIGTERM');
    this.lastStatus = { ready: false, state: 'stopped', message: 'Local search is stopped while idle.' };
    return { stopped: true, message: 'Local search stopped while idle.' };
  }

  async ensureReady() {
    const current = await this.health();
    if (current.ready || !this.managed) {
      this.lastStatus = current;
      return current;
    }

    if (!this.installed()) {
      this.setup().then((result) => {
        if (result.installed) this.start().catch(() => {});
      }).catch(() => {});
      this.lastStatus = { ready: false, state: 'installing', message: 'Installing local search in .naow/search.' };
      return this.lastStatus;
    }

    const start = await this.start();
    if (!start.started) {
      this.lastStatus = { ready: false, state: 'unavailable', message: start.message };
      return this.lastStatus;
    }

    for (let index = 0; index < 8; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const next = await this.health();
      if (next.ready) {
        this.lastStatus = next;
        return next;
      }
    }

    this.lastStatus = { ready: false, state: 'starting', message: 'Local search is still starting.' };
    return this.lastStatus;
  }

  async status() {
    const health = await this.health();
    this.lastStatus = health;
    return {
      provider: 'searxng',
      managed: this.managed,
      mode: 'native',
      installed: this.installed(),
      installing: Boolean(this.settingUp),
      running: Boolean(this.process),
      url: this.url,
      ...health
    };
  }
}

export { NativeSearxngSidecar as SearxngSidecar };
