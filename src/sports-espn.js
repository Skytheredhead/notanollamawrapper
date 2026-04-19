/**
 * Public ESPN site.json-style endpoints (no API key). May change; best-effort normalization.
 */

const LEAGUE_PATH = {
  nfl: 'football/nfl',
  nba: 'basketball/nba',
  mlb: 'baseball/mlb',
  nhl: 'hockey/nhl',
  epl: 'soccer/eng.1',
  mls: 'soccer/usa.1',
  ucl: 'soccer/uefa.champions',
  cfb: 'football/college-football'
};

const SITE = 'https://site.api.espn.com';

export function normalizeLeague(key) {
  const k = String(key || 'nfl').toLowerCase();
  return LEAGUE_PATH[k] ? k : 'nfl';
}

export function leaguePath(leagueKey) {
  return LEAGUE_PATH[normalizeLeague(leagueKey)] || LEAGUE_PATH.nfl;
}

export async function fetchScores(leagueKey, { fetchImpl = fetch, signal } = {}) {
  const path = leaguePath(leagueKey);
  const url = `${SITE}/apis/site/v2/sports/${path}/scoreboard`;
  const r = await fetchImpl(url, { signal, headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Scores unavailable (${r.status})`);
  const data = await r.json();
  const events = Array.isArray(data?.events) ? data.events : [];
  const games = events.slice(0, 16).map((ev) => {
    const comp = ev?.competitions?.[0];
    const teams = (comp?.competitors || []).map((c) => ({
      name: c?.team?.displayName || c?.team?.name || '',
      abbrev: c?.team?.abbreviation || '',
      score: c?.score != null ? String(c.score) : '',
      homeAway: c?.homeAway || ''
    }));
    const status = comp?.status?.type?.detail || comp?.status?.type?.shortDetail || '';
    const date = comp?.date || ev?.date || '';
    return { id: ev?.id, name: ev?.name, date, status, teams };
  });
  return {
    league: normalizeLeague(leagueKey),
    leaguePath: path,
    games,
    rawEventCount: events.length
  };
}

function collectStandingsTeams(node, out, depth = 0) {
  if (depth > 20 || !node || typeof node !== 'object') return;
  if (node.team?.displayName && node.team?.id) {
    const summary = node.summary || node.stats?.splits?.summary || '';
    out.push({ team: node.team.displayName, abbrev: node.team.abbreviation, summary });
  }
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach((item) => collectStandingsTeams(item, out, depth + 1));
    else if (v && typeof v === 'object') collectStandingsTeams(v, out, depth + 1);
  }
}

export async function fetchStandings(leagueKey, { fetchImpl = fetch, signal } = {}) {
  const path = leaguePath(leagueKey);
  const url = `${SITE}/apis/v2/sports/${path}/standings`;
  const r = await fetchImpl(url, { signal, headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Standings unavailable (${r.status})`);
  const data = await r.json();
  const standings = [];
  collectStandingsTeams(data, standings);
  const dedup = [];
  const seen = new Set();
  for (const row of standings) {
    const k = row.team;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(row);
    if (dedup.length >= 32) break;
  }
  return { league: normalizeLeague(leagueKey), standings: dedup };
}

export async function fetchTeamSearch(query, leagueKey, { fetchImpl = fetch, signal } = {}) {
  const path = leaguePath(leagueKey);
  const url = `${SITE}/apis/site/v2/sports/${path}/teams?limit=100`;
  const r = await fetchImpl(url, { signal, headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Team list unavailable (${r.status})`);
  const data = await r.json();
  const teams = data?.sports?.[0]?.leagues?.[0]?.teams || [];
  const lower = String(query || '').toLowerCase().trim();
  const match = teams
    .map((t) => t?.team)
    .filter(Boolean)
    .find(
      (t) =>
        String(t.displayName || '')
          .toLowerCase()
          .includes(lower) ||
        String(t.abbreviation || '')
          .toLowerCase() === lower ||
        String(t.shortDisplayName || '')
          .toLowerCase()
          .includes(lower)
    );
  if (!match) return { league: normalizeLeague(leagueKey), team: null, message: 'Team not found.' };
  return {
    league: normalizeLeague(leagueKey),
    team: {
      name: match.displayName,
      abbrev: match.abbreviation,
      location: match.location,
      record: match.record?.items?.[0]?.summary,
      standingSummary: match.standingSummary,
      logo: match.logos?.[0]?.href
    }
  };
}

export async function fetchAthleteSearch(query, { fetchImpl = fetch, signal } = {}) {
  const q = encodeURIComponent(String(query || '').trim());
  const url = `${SITE}/apis/common/v3/search?query=${q}&limit=8`;
  const r = await fetchImpl(url, { signal, headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Player search failed (${r.status})`);
  const data = await r.json();
  const items = data?.results?.[0]?.contents || data?.results || [];
  const athletes = [];
  for (const block of Array.isArray(items) ? items : []) {
    const contents = block?.contents || block?.items || [];
    for (const c of Array.isArray(contents) ? contents : [block]) {
      const a = c?.athlete || c;
      if (a?.displayName || a?.fullName) {
        athletes.push({
          name: a.displayName || a.fullName,
          position: a.position?.abbreviation || a.position?.displayName,
          team: a.team?.displayName || a.team?.name,
          headshot: a.headshot?.href || a.headshot,
          id: a.id
        });
      }
    }
  }
  const dedup = [];
  const seen = new Set();
  for (const p of athletes) {
    const k = p.name;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(p);
    if (dedup.length >= 6) break;
  }
  return { players: dedup };
}

export async function fetchSports({ action = 'scores', league = 'nfl', query = '' }, opts) {
  const lg = normalizeLeague(league);
  const q = String(query || '').trim();
  switch (action) {
    case 'standings':
      return fetchStandings(lg, opts);
    case 'team':
      if (!q) throw new Error('Team name required.');
      return fetchTeamSearch(q, lg, opts);
    case 'player':
      if (!q) throw new Error('Player name required.');
      return fetchAthleteSearch(q, opts);
    case 'schedule':
    case 'scores':
    default:
      return fetchScores(lg, opts);
  }
}
