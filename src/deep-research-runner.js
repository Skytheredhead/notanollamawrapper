import {
  DEEP_RESEARCH_GOAL_SYSTEM,
  DEEP_RESEARCH_ORCHESTRATOR_SYSTEM,
  DEEP_RESEARCH_SUMMARY_SYSTEM
} from './deep-research-prompt.js';

const SESSION_MS = 60 * 60 * 1000;
const WARN_SEARCHES_PER_GOAL = 175;
const HARD_STOP_SEARCHES_PER_GOAL = 200;
const MAX_GOAL_TURNS = 400;
// Extremely large context windows can destabilize some MLX models (or exhaust memory).
// Keep this conservative; the runner can still do multiple goals/turns without needing 262k ctx.
const DR_NUM_CTX = 65536;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function parseGoalsJson(text) {
  const raw = String(text || '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    const goals = Array.isArray(parsed.goals) ? parsed.goals.map((g) => String(g || '').trim()).filter(Boolean) : [];
    if (goals.length < 2) return null;
    while (goals.length < 3) {
      goals.push(`Additional angle on: ${goals[0]}`);
    }
    return goals.slice(0, 5);
  } catch {
    return null;
  }
}

function parseAction(text) {
  const t = String(text || '');
  if (/ACTION:\s*GOAL_DONE/i.test(t)) {
    const notes = t.match(/NOTES:\s*([\s\S]*?)$/im)?.[1]?.trim() || '';
    return { type: 'done', notes };
  }
  const m = t.match(/ACTION:\s*SEARCH[\s\S]*?QUERY:\s*([^\n\r]+)/i);
  if (m) return { type: 'search', query: m[1].trim() };
  return { type: 'none' };
}

function formatSearchBatch(result, maxChars) {
  const results = Array.isArray(result?.results) ? result.results : [];
  const lines = results.slice(0, 10).map((r, i) => {
    const title = String(r.title || '').slice(0, 120);
    const url = String(r.url || '');
    const snippet = String(r.snippet || r.content || '').replace(/\s+/g, ' ').slice(0, 280);
    return `${i + 1}. ${title}\n   ${url}\n   ${snippet}`;
  });
  const body = lines.join('\n\n');
  if (body.length <= maxChars) return body;
  return `${body.slice(0, Math.max(0, maxChars - 20))}\n[truncated]`;
}

function searchLooksFailed(result) {
  if (!result) return true;
  if (result.skipped === 'no_results' || result.skipped === 'empty_query') return false;
  if (result.skipped) return true;
  if (Array.isArray(result.results) && result.results.length) return false;
  return true;
}

async function resilientSearch(searchClient, config, query, { signal, onEvent, shouldFastForward, deadline }) {
  const maxResults = config.searchMaxResults || 5;
  const tryOnce = () => searchClient.search(query, { signal, maxResults });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (Date.now() > deadline) throw new Error('session_timeout');
    if (signal?.aborted) throw new Error('aborted');
    if (shouldFastForward?.()) onEvent?.({ type: 'resume_skip' });
    const result = await tryOnce();
    if (!searchLooksFailed(result)) return result;
    onEvent?.({
      type: 'search_backoff',
      phase: 'fast',
      attempt: attempt + 1,
      message: result?.message || result?.skipped || 'search_failed'
    });
    const step = 1000;
    let waited = 0;
    while (waited < 5000) {
      if (Date.now() > deadline) throw new Error('session_timeout');
      if (signal?.aborted) throw new Error('aborted');
      if (shouldFastForward?.()) break;
      await sleep(Math.min(step, 5000 - waited), signal);
      waited += step;
    }
  }

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('aborted');
    onEvent?.({ type: 'search_backoff', phase: 'slow', nextRetryInMs: 120000 });
    let waited = 0;
    const step = 1000;
    while (waited < 120000 && Date.now() < deadline) {
      if (signal?.aborted) throw new Error('aborted');
      if (shouldFastForward?.()) break;
      await sleep(Math.min(step, 120000 - waited), signal);
      waited += step;
    }
    const result = await tryOnce();
    if (!searchLooksFailed(result)) return result;
  }
  throw new Error('session_timeout');
}

async function mlxStreamComplete(ollama, { model, messages, options, signal }) {
  let content = '';
  for await (const chunk of ollama.streamChat({ model, messages, options, signal })) {
    if (chunk.type === 'token') content += chunk.delta;
    if (chunk.type === 'done') break;
  }
  return content.trim();
}

async function summarizeGoal(ollama, { model, goal, notes, signal }) {
  return mlxStreamComplete(ollama, {
    model,
    messages: [
      { role: 'system', content: DEEP_RESEARCH_SUMMARY_SYSTEM },
      { role: 'user', content: `Goal:\n${goal}\n\nRaw notes:\n${notes}` }
    ],
    options: {
      num_ctx: 32768,
      max_tokens: 2048,
      temperature: 0.2,
      residency: 'always_hot'
    },
    signal
  });
}

export async function runDeepResearchRunner(ctx) {
  const {
    db,
    ollama,
    searchClient,
    config,
    chatId,
    topic,
    model,
    signal,
    onEvent,
    shouldFastForward
  } = ctx;

  const drOptions = {
    num_ctx: DR_NUM_CTX,
    max_tokens: 4096,
    temperature: 0.35,
    residency: config.mlxResidency || 'always_hot'
  };

  const sessionStart = Date.now();
  const deadline = sessionStart + SESSION_MS;

  const userLine = db.createUserMessage(chatId, `**Deep research:** ${topic}`);

  onEvent?.({ type: 'phase', phase: 'planning' });

  const planText = await mlxStreamComplete(ollama, {
    model,
    messages: [
      { role: 'system', content: DEEP_RESEARCH_ORCHESTRATOR_SYSTEM },
      { role: 'user', content: `Research topic:\n${topic}` }
    ],
    options: { ...drOptions, max_tokens: 2048, temperature: 0.25 },
    signal
  });

  let goals = parseGoalsJson(planText);
  if (!goals) {
    goals = [
      `Frame the problem and key definitions for: ${topic}`,
      `Survey credible sources and recent developments`,
      `Compare options and extract tradeoffs`,
      `Synthesize recommendations and open questions`
    ];
    onEvent?.({ type: 'goals_fallback' });
  }
  onEvent?.({ type: 'goals', goals });

  let masterSummary = '';

  goalLoop:
  for (let gi = 0; gi < goals.length; gi += 1) {
    if (Date.now() > deadline) {
      onEvent?.({ type: 'session_timeout' });
      break goalLoop;
    }

    const goal = goals[gi];
    onEvent?.({ type: 'goal_start', index: gi, total: goals.length, goal, searchesThisGoal: 0 });

    let searchesThisGoal = 0;
    const thread = [];

    for (let turn = 0; turn < MAX_GOAL_TURNS; turn += 1) {
      if (Date.now() > deadline) {
        onEvent?.({ type: 'session_timeout' });
        break goalLoop;
      }

      if (searchesThisGoal >= HARD_STOP_SEARCHES_PER_GOAL) {
        onEvent?.({ type: 'goal_search_cap', index: gi });
        const bundle = thread.map((m) => `[${m.role}] ${m.content}`).join('\n\n');
        const summary = await summarizeGoal(ollama, { model, goal, notes: bundle, signal });
        masterSummary += `\n\n### Goal ${gi + 1} (search cap): ${goal}\n${summary}`;
        onEvent?.({ type: 'goal_summary', index: gi, summary });
        break;
      }

      let userExtra = '';
      if (searchesThisGoal >= WARN_SEARCHES_PER_GOAL) {
        userExtra += `\n\nWARNING: You have used ${searchesThisGoal} searches on this goal (hard stop at ${HARD_STOP_SEARCHES_PER_GOAL}). Finish with ACTION: GOAL_DONE immediately.\n`;
      }

      const userBlock = [
        `Research topic: ${topic}`,
        masterSummary ? `\n## Prior goals (summary)\n${masterSummary}\n` : '',
        `\n## Current goal (${gi + 1}/${goals.length})\n${goal}\n`,
        thread.length
          ? `\n## Conversation (this goal)\n${thread.map((m) => `${m.role}: ${m.content}`).join('\n\n')}\n`
          : '',
        userExtra,
        '\nDecide the next step. End with ACTION: SEARCH / QUERY: or ACTION: GOAL_DONE / NOTES:.'
      ].join('');

      const assistantText = await mlxStreamComplete(ollama, {
        model,
        messages: [
          { role: 'system', content: DEEP_RESEARCH_GOAL_SYSTEM },
          { role: 'user', content: userBlock }
        ],
        options: drOptions,
        signal
      });

      thread.push({ role: 'assistant', content: assistantText });
      const action = parseAction(assistantText);

      if (action.type === 'done') {
        thread.push({ role: 'user', content: `Acknowledged goal completion. Notes: ${action.notes || ''}` });
        onEvent?.({ type: 'goal_done', index: gi, notes: action.notes });
        const bundle = thread.map((m) => `[${m.role}] ${m.content}`).join('\n\n');
        const summary = await summarizeGoal(ollama, { model, goal, notes: bundle, signal });
        masterSummary += `\n\n### Goal ${gi + 1}: ${goal}\n${summary}`;
        onEvent?.({ type: 'goal_summary', index: gi, summary });
        break;
      }

      if (action.type === 'none') {
        thread.push({
          role: 'user',
          content:
            'Your last message did not include a valid ACTION block. Reply again ending with ACTION: SEARCH and QUERY: ... or ACTION: GOAL_DONE with NOTES: ...'
        });
        continue;
      }

      if (action.type === 'search') {
        if (!action.query) {
          thread.push({ role: 'user', content: 'QUERY was empty. Provide ACTION: SEARCH with a non-empty QUERY line.' });
          continue;
        }
        searchesThisGoal += 1;
        onEvent?.({
          type: 'search',
          index: gi,
          query: action.query,
          searchesThisGoal
        });

        const batch = await resilientSearch(searchClient, config, action.query, {
          signal,
          onEvent,
          shouldFastForward,
          deadline
        });
        const formatted = formatSearchBatch(batch, config.toolMaxResultChars || 8000);
        thread.push({
          role: 'user',
          content: `Search results for "${action.query}":\n${formatted}`
        });

        if (searchesThisGoal >= HARD_STOP_SEARCHES_PER_GOAL) {
          onEvent?.({ type: 'goal_forced_advance', index: gi, reason: 'search_cap' });
          const bundle = thread.map((m) => `[${m.role}] ${m.content}`).join('\n\n');
          const summary = await summarizeGoal(ollama, { model, goal, notes: bundle, signal });
          masterSummary += `\n\n### Goal ${gi + 1} (stopped at search cap): ${goal}\n${summary}`;
          break;
        }
      }
    }
  }

  const report = await mlxStreamComplete(ollama, {
    model,
    messages: [
      {
        role: 'system',
        content:
          'Write the final deep research report for the user. Be thorough and well structured. Use markdown headings.'
      },
      {
        role: 'user',
        content: `Original topic:\n${topic}\n\nAccumulated summaries:\n${masterSummary || '(no notes)'}`
      }
    ],
    options: { ...drOptions, max_tokens: 8192 },
    signal
  });

  onEvent?.({ type: 'final_draft', content: report });

  const genId = `deep-research-${userLine.id}`;
  const assistant = db.createAssistantMessage(chatId, genId);
  db.finalizeMessage(assistant.id, {
    content: report,
    status: 'complete',
    metadata: { deepResearch: true, topic, goals }
  });

  onEvent?.({
    type: 'complete',
    messageId: assistant.id,
    userMessageId: userLine.id
  });

  return { report, messageId: assistant.id, userMessageId: userLine.id };
}
