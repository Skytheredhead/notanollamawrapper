/** Common place names → IANA timezone (subset for local tool). */

export const PLACE_TO_TZ = {
  utc: 'UTC',
  gmt: 'UTC',
  london: 'Europe/London',
  paris: 'Europe/Paris',
  berlin: 'Europe/Berlin',
  rome: 'Europe/Rome',
  madrid: 'Europe/Madrid',
  amsterdam: 'Europe/Amsterdam',
  brussels: 'Europe/Brussels',
  vienna: 'Europe/Vienna',
  warsaw: 'Europe/Warsaw',
  athens: 'Europe/Athens',
  istanbul: 'Europe/Istanbul',
  moscow: 'Europe/Moscow',
  dubai: 'Asia/Dubai',
  delhi: 'Asia/Kolkata',
  mumbai: 'Asia/Kolkata',
  bangkok: 'Asia/Bangkok',
  singapore: 'Asia/Singapore',
  hongkong: 'Asia/Hong_Kong',
  shanghai: 'Asia/Shanghai',
  tokyo: 'Asia/Tokyo',
  seoul: 'Asia/Seoul',
  sydney: 'Australia/Sydney',
  melbourne: 'Australia/Melbourne',
  auckland: 'Pacific/Auckland',
  'new york': 'America/New_York',
  nyc: 'America/New_York',
  boston: 'America/New_York',
  miami: 'America/New_York',
  washington: 'America/New_York',
  chicago: 'America/Chicago',
  houston: 'America/Chicago',
  dallas: 'America/Chicago',
  denver: 'America/Denver',
  phoenix: 'America/Phoenix',
  'los angeles': 'America/Los_Angeles',
  la: 'America/Los_Angeles',
  seattle: 'America/Los_Angeles',
  'san francisco': 'America/Los_Angeles',
  sf: 'America/Los_Angeles',
  vancouver: 'America/Vancouver',
  toronto: 'America/Toronto',
  montreal: 'America/Toronto',
  mexico: 'America/Mexico_City',
  sao: 'America/Sao_Paulo',
  buenos: 'America/Argentina/Buenos_Aires',
  cairo: 'Africa/Cairo',
  johannesburg: 'Africa/Johannesburg',
  lagos: 'Africa/Lagos'
};

export function resolvePlaceToTimezone(place) {
  const key = String(place || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ');
  if (!key) return '';
  if (/^[a-z_]+\/[a-z_]+$/i.test(String(place).trim())) return String(place).trim();
  return PLACE_TO_TZ[key] || '';
}

export function formatClockLabel(tz) {
  try {
    const now = new Date();
    const time = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).format(now);
    const date = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    }).format(now);
    return { time, date, tz };
  } catch {
    return { time: '—', date: '', tz };
  }
}

export function buildWorldClockRows(places = []) {
  const rows = [];
  for (const raw of places) {
    const s = String(raw).trim();
    if (!s) continue;
    let tz = resolvePlaceToTimezone(s) || resolvePlaceToTimezone(s.replace(/,/g, ''));
    if (!tz && /^[A-Za-z_]+\/[A-Za-z_+\-]+$/.test(s)) tz = s;
    if (!tz) continue;
    const { time, date } = formatClockLabel(tz);
    rows.push({
      label: s,
      timezone: tz,
      time,
      date
    });
  }
  return rows;
}
