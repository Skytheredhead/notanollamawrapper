function nowMs() {
  return Date.now();
}

function cacheGet(cache, key) {
  const entry = cache.get(key);
  if (!entry || entry.expiresAt <= nowMs()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(cache, key, value, ttlMs) {
  cache.set(key, {
    value,
    expiresAt: nowMs() + ttlMs
  });
  return value;
}

function anySignal(signals) {
  const valid = signals.filter(Boolean);
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(valid);
  return valid[0];
}

function weatherCodeSummary(code) {
  const value = Number(code);
  if (value === 0) return 'Clear';
  if ([1, 2, 3].includes(value)) return 'Partly cloudy';
  if ([45, 48].includes(value)) return 'Fog';
  if ([51, 53, 55, 56, 57].includes(value)) return 'Drizzle';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(value)) return 'Rain';
  if ([71, 73, 75, 77, 85, 86].includes(value)) return 'Snow';
  if ([95, 96, 99].includes(value)) return 'Thunderstorms';
  return 'Unknown';
}

export class WeatherClient {
  constructor({
    geocodeUrl,
    forecastUrl,
    timeoutMs = 1800,
    fetchImpl = fetch
  }) {
    this.geocodeUrl = geocodeUrl;
    this.forecastUrl = forecastUrl;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.geocodeCache = new Map();
    this.weatherCache = new Map();
    this.inFlight = new Map();
  }

  async fetchJson(url, { signal } = {}) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort('timeout'), this.timeoutMs);
    const requestSignal = anySignal([abort.signal, signal]);
    try {
      const response = await this.fetch(url, { signal: requestSignal });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Weather request returned HTTP ${response.status}${body ? `: ${body}` : ''}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async geocode(location, { signal } = {}) {
    const query = String(location || '').trim();
    if (!query) throw new Error('Weather needs a location.');
    const cacheKey = query.toLowerCase();
    const cached = cacheGet(this.geocodeCache, cacheKey);
    if (cached) return { ...cached, cacheHit: true };

    const url = new URL(this.geocodeUrl);
    url.searchParams.set('name', query);
    url.searchParams.set('count', '5');
    url.searchParams.set('language', 'en');
    url.searchParams.set('format', 'json');

    const payload = await this.fetchJson(url, { signal });
    const [best] = payload.results || [];
    if (!best) throw new Error(`No weather location found for "${query}".`);
    const result = {
      name: best.name,
      admin1: best.admin1 || '',
      country: best.country || '',
      latitude: best.latitude,
      longitude: best.longitude,
      timezone: best.timezone || 'auto'
    };
    return cacheSet(this.geocodeCache, cacheKey, result, 24 * 60 * 60 * 1000);
  }

  async forecast({ location, days = 3, signal } = {}) {
    const place = await this.geocode(location, { signal });
    const forecastDays = Math.max(1, Math.min(7, Number.parseInt(days, 10) || 3));
    const cacheKey = [
      Number(place.latitude).toFixed(3),
      Number(place.longitude).toFixed(3),
      forecastDays
    ].join(':');
    const cached = cacheGet(this.weatherCache, cacheKey);
    if (cached) return { ...cached, cacheHit: true };

    if (this.inFlight.has(cacheKey)) return this.inFlight.get(cacheKey);

    const promise = (async () => {
      const url = new URL(this.forecastUrl);
      url.searchParams.set('latitude', String(place.latitude));
      url.searchParams.set('longitude', String(place.longitude));
      url.searchParams.set('current', [
        'temperature_2m',
        'apparent_temperature',
        'relative_humidity_2m',
        'precipitation',
        'weather_code',
        'wind_speed_10m',
        'wind_gusts_10m'
      ].join(','));
      url.searchParams.set('daily', [
        'weather_code',
        'temperature_2m_max',
        'temperature_2m_min',
        'precipitation_probability_max',
        'precipitation_sum',
        'wind_speed_10m_max'
      ].join(','));
      url.searchParams.set('forecast_days', String(forecastDays));
      url.searchParams.set('temperature_unit', 'fahrenheit');
      url.searchParams.set('wind_speed_unit', 'mph');
      url.searchParams.set('precipitation_unit', 'inch');
      url.searchParams.set('timezone', 'auto');

      const payload = await this.fetchJson(url, { signal });
      const current = payload.current || {};
      const daily = payload.daily || {};
      const result = {
        source: 'Open-Meteo',
        location: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
        latitude: place.latitude,
        longitude: place.longitude,
        timezone: payload.timezone || place.timezone || 'auto',
        current: {
          time: current.time || '',
          temperatureF: current.temperature_2m,
          feelsLikeF: current.apparent_temperature,
          humidityPercent: current.relative_humidity_2m,
          precipitationIn: current.precipitation,
          windMph: current.wind_speed_10m,
          gustMph: current.wind_gusts_10m,
          summary: weatherCodeSummary(current.weather_code)
        },
        forecast: (daily.time || []).map((time, index) => ({
          date: time,
          summary: weatherCodeSummary(daily.weather_code?.[index]),
          highF: daily.temperature_2m_max?.[index],
          lowF: daily.temperature_2m_min?.[index],
          precipitationChancePercent: daily.precipitation_probability_max?.[index],
          precipitationIn: daily.precipitation_sum?.[index],
          maxWindMph: daily.wind_speed_10m_max?.[index]
        })),
        cacheHit: false
      };
      return cacheSet(this.weatherCache, cacheKey, result, 5 * 60 * 1000);
    })().finally(() => {
      this.inFlight.delete(cacheKey);
    });

    this.inFlight.set(cacheKey, promise);
    return promise;
  }
}
