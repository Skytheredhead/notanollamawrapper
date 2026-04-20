import { runDeepResearchRunner } from './deep-research-runner.js';

function now() {
  return Date.now();
}

export class DeepResearchManager {
  constructor() {
    /** @type {Map<string, object>} */
    this.jobs = new Map();
    /** @type {Map<string, { at: number, count: number }>} */
    this.manualRetryBudget = new Map();
  }

  getStatus(chatId) {
    return this.jobs.get(chatId) || null;
  }

  canManualRetry(chatId) {
    const windowMs = 60_000;
    const maxPerWindow = 6;
    const minGapMs = 8000;
    const key = chatId;
    const entry = this.manualRetryBudget.get(key) || { at: 0, count: 0, last: 0 };
    const t = now();
    if (entry.last && t - entry.last < minGapMs) {
      return { ok: false, reason: 'rate_limited', retryAfterMs: minGapMs - (t - entry.last) };
    }
    if (t - entry.at > windowMs) {
      entry.at = t;
      entry.count = 0;
    }
    if (entry.count >= maxPerWindow) {
      return { ok: false, reason: 'quota', retryAfterMs: windowMs - (t - entry.at) };
    }
    entry.count += 1;
    entry.last = t;
    this.manualRetryBudget.set(key, entry);
    return { ok: true };
  }

  requestResume(chatId) {
    const job = this.jobs.get(chatId);
    if (!job) return false;
    job.resumeRequested = true;
    return true;
  }

  consumeResume(chatId) {
    const job = this.jobs.get(chatId);
    if (!job || !job.resumeRequested) return false;
    job.resumeRequested = false;
    return true;
  }

  stop(chatId) {
    const job = this.jobs.get(chatId);
    if (!job?.abortController) return false;
    job.abortController.abort();
    job.phase = 'stopped';
    job.updatedAt = now();
    return true;
  }

  /**
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async start({
    chatId,
    topic,
    db,
    ollama,
    searchClient,
    config
  }) {
    if (this.jobs.get(chatId)?.phase === 'running') {
      return { ok: false, error: 'Deep research already running for this chat.' };
    }

    const abortController = new AbortController();
    const state = {
      phase: 'running',
      topic: String(topic || '').trim(),
      goals: [],
      currentGoalIndex: 0,
      searchesThisGoal: 0,
      log: [],
      pausedMessage: null,
      nextRetryInMs: null,
      updatedAt: now(),
      resumeRequested: false,
      abortController,
      error: null,
      messageId: null
    };
    this.jobs.set(chatId, state);

    const onEvent = (ev) => {
      state.updatedAt = now();
      if (ev.type === 'goals') state.goals = ev.goals || [];
      if (ev.type === 'goal_start') {
        state.currentGoalIndex = ev.index;
        state.searchesThisGoal = 0;
      }
      if (ev.type === 'search') state.searchesThisGoal = ev.searchesThisGoal;
      if (ev.type === 'search_backoff') {
        state.pausedMessage =
          ev.phase === 'slow'
            ? 'Paused · retrying search (every 2 min)'
            : `Retrying search (${ev.attempt}/5)…`;
        state.nextRetryInMs = ev.nextRetryInMs ?? (ev.phase === 'fast' ? 5000 : 120000);
      } else if (ev.type === 'resume_skip') {
        state.pausedMessage = 'Retrying now…';
        state.nextRetryInMs = null;
      } else {
        state.pausedMessage = null;
        state.nextRetryInMs = null;
      }
      if (ev.type === 'complete') {
        state.phase = 'complete';
        state.messageId = ev.messageId;
      }
      if (ev.type === 'session_timeout') {
        state.pausedMessage = 'Session time limit reached (1 hour).';
      }
    };

    const model = config.deepResearchModel || config.mlxModel;

    (async () => {
      try {
        await runDeepResearchRunner({
          db,
          ollama,
          searchClient,
          config,
          chatId,
          topic: state.topic,
          model,
          signal: abortController.signal,
          onEvent,
          shouldFastForward: () => this.consumeResume(chatId)
        });
        if (state.phase !== 'complete') state.phase = 'complete';
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === 'aborted' || abortController.signal.aborted) {
          state.phase = 'stopped';
          state.error = null;
        } else {
          state.phase = 'error';
          state.error = msg;
        }
      } finally {
        state.updatedAt = now();
        if (state.phase === 'running') {
          state.phase = state.error ? 'error' : 'complete';
        }
      }
    })();

    return { ok: true };
  }
}
