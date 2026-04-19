import assert from 'node:assert/strict';
import test from 'node:test';
import { prependToolsContext } from '../src/tool-context.js';
import { createToolRuntime, executeTool, runFastTool, toolOptionsFromBody } from '../src/tool-registry.js';

const config = {
  weatherGeocodeUrl: 'https://geo.test/search',
  weatherForecastUrl: 'https://forecast.test/forecast',
  toolTimeoutMs: 1000,
  toolMaxResultChars: 3000,
  webSearchMaxResults: 3
};

test('tools markdown context is prepended before user messages', () => {
  const messages = [{ role: 'user', content: 'hello' }];
  const next = prependToolsContext(messages, { filePath: 'tools.md', toolsEnabled: false });
  assert.equal(next[0].role, 'system');
  assert.match(next[0].content, /naow Tools/);
  assert.match(next[0].content, /Tool execution is disabled/);
  assert.equal(next[1].content, 'hello');
});

test('calculator fast path evaluates arithmetic without eval', async () => {
  const runtime = createToolRuntime(config, { webSearch: async () => ({ results: [] }) });
  const toolsOptions = toolOptionsFromBody({}, { webSearch: false });
  const result = await runFastTool('what is (2 + 3) * 4?', runtime, { toolsOptions });
  assert.equal(result.name, 'calculate');
  assert.equal(result.result.result, 20);
  assert.equal(result.text, '20');
  const casual = await runFastTool('whats 5*5', runtime, { toolsOptions });
  assert.equal(casual.name, 'calculate');
  assert.equal(casual.result.result, 25);
  assert.equal(casual.text, '25');
  await assert.rejects(() => executeTool('calculate', { expression: 'process.exit()' }, runtime), /Function process needs parentheses|Unknown function/);
});

test('weather fast path treats a location-only reply as the requested weather location', async () => {
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.startsWith('https://geo.test')) {
      return Response.json({
        results: [{
          name: 'Sammamish',
          admin1: 'Washington',
          country: 'United States',
          latitude: 47.61,
          longitude: -122.04,
          timezone: 'America/Los_Angeles'
        }]
      });
    }
    return Response.json({
      timezone: 'America/Los_Angeles',
      current: {
        time: '2026-04-18T21:00',
        temperature_2m: 52,
        apparent_temperature: 51,
        relative_humidity_2m: 80,
        precipitation: 0,
        weather_code: 3,
        wind_speed_10m: 5,
        wind_gusts_10m: 9
      },
      daily: {
        time: ['2026-04-18'],
        weather_code: [3],
        temperature_2m_max: [58],
        temperature_2m_min: [45],
        precipitation_probability_max: [20],
        precipitation_sum: [0],
        wind_speed_10m_max: [7]
      }
    });
  };
  const runtime = createToolRuntime(config, {}, fetchImpl);
  const toolsOptions = toolOptionsFromBody({}, { webSearch: false });
  const result = await runFastTool('sammamish, wa', runtime, {
    toolsOptions,
    messages: [
      { role: 'user', content: 'yo whats the weather right now?' },
      { role: 'assistant', content: 'What location should I check the weather for?' },
      { role: 'user', content: 'sammamish, wa' }
    ]
  });
  assert.equal(result.name, 'get_weather');
  assert.match(result.text, /^Sammamish:/);
  assert.match(result.text, /52°F/);
});

test('stopwatch start is not treated as a weather follow-up location', async () => {
  const runtime = createToolRuntime(config, { webSearch: async () => ({ results: [] }) });
  const toolsOptions = toolOptionsFromBody({}, { webSearch: false });
  const result = await runFastTool('start a stopwatch', runtime, {
    toolsOptions,
    messages: [
      { role: 'user', content: 'whats the weather in sammamish' },
      { role: 'assistant', content: 'Here is the forecast.' }
    ]
  });
  assert.equal(result.name, 'stopwatch_start');
});

test('unit conversion handles common units', async () => {
  const runtime = createToolRuntime(config, { webSearch: async () => ({ results: [] }) });
  const result = await executeTool('convert_units', { value: 1, from: 'mile', to: 'km' }, runtime);
  assert.equal(result.name, 'convert_units');
  assert.ok(Math.abs(result.result.result - 1.609344) < 0.000001);
});

test('graph_math samples functions of x', async () => {
  const runtime = createToolRuntime(config, { webSearch: async () => ({ results: [] }) });
  const result = await executeTool('graph_math', { expressions: ['x^2'], xMin: -2, xMax: 2 }, runtime);
  assert.equal(result.name, 'graph_math');
  assert.ok(Array.isArray(result.result.series));
  assert.ok(result.result.series[0].points.length > 50);
  const mid = result.result.series[0].points[Math.floor(result.result.series[0].points.length / 2)];
  assert.ok(Math.abs(mid.x) < 0.1);
  assert.ok(Math.abs(mid.y) < 0.05);
  const toolsOptions = toolOptionsFromBody({}, { webSearch: false });
  const fast = await runFastTool('plot sin(x) and cos(x)', runtime, { toolsOptions });
  assert.equal(fast.name, 'graph_math');
  assert.ok(fast.result.expressions.length >= 2);
});

test('hardcoded utility prompts trigger deterministic fast paths', async () => {
  const runtime = createToolRuntime(config, { webSearch: async () => ({ results: [] }) });
  const toolsOptions = toolOptionsFromBody({}, { webSearch: false });

  const base64 = await runFastTool('base64 encode "hello"', runtime, { toolsOptions });
  assert.equal(base64.name, 'base64_codec');
  assert.equal(base64.text, 'aGVsbG8=');

  const hash = await runFastTool('sha256 hash "hello"', runtime, { toolsOptions });
  assert.equal(hash.name, 'hash_text');
  assert.equal(hash.text, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');

  const json = await runFastTool('format json {"b":2,"a":1}', runtime, { toolsOptions });
  assert.equal(json.name, 'json_format');
  assert.match(json.text, /\n  "b": 2/);

  const color = await runFastTool('convert color #ff0000', runtime, { toolsOptions });
  assert.equal(color.name, 'color_convert');
  assert.equal(color.text, '#ff0000 = rgb(255, 0, 0)');

  const transform = await runFastTool('uppercase "hello friend"', runtime, { toolsOptions });
  assert.equal(transform.name, 'text_transform');
  assert.equal(transform.text, 'HELLO FRIEND');
});

test('web_search tool uses the local search client', async () => {
  let searched = false;
  const searchClient = {
    async search(query, { maxResults }) {
      searched = true;
      assert.equal(query, 'mlx releases');
      assert.equal(maxResults, 3);
      return {
        provider: 'searxng',
        results: [{ title: 'MLX', url: 'https://example.com/mlx', content: 'Local search result.' }],
        cacheHit: false
      };
    }
  };
  const runtime = createToolRuntime(config, { webSearch: async () => { throw new Error('Ollama search should not be used.'); } }, searchClient);
  const result = await executeTool('web_search', { query: 'mlx releases' }, runtime);
  assert.equal(searched, true);
  assert.equal(result.source, 'Local searxng search');
  assert.match(result.text, /Local search result/);
});

test('weather client geocodes, forecasts, and caches repeat calls', async () => {
  let geocodeCalls = 0;
  let forecastCalls = 0;
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.startsWith('https://geo.test')) {
      geocodeCalls += 1;
      return Response.json({
        results: [{
          name: 'San Francisco',
          admin1: 'California',
          country: 'United States',
          latitude: 37.77,
          longitude: -122.42,
          timezone: 'America/Los_Angeles'
        }]
      });
    }
    forecastCalls += 1;
    return Response.json({
      timezone: 'America/Los_Angeles',
      current: {
        time: '2026-04-18T12:00',
        temperature_2m: 65,
        apparent_temperature: 64,
        relative_humidity_2m: 55,
        precipitation: 0,
        weather_code: 0,
        wind_speed_10m: 8,
        wind_gusts_10m: 12
      },
      daily: {
        time: ['2026-04-18'],
        weather_code: [0],
        temperature_2m_max: [68],
        temperature_2m_min: [52],
        precipitation_probability_max: [5],
        precipitation_sum: [0],
        wind_speed_10m_max: [13]
      }
    });
  };
  const runtime = createToolRuntime(config, { webSearch: async () => ({ results: [] }) }, fetchImpl);
  const first = await executeTool('get_weather', { location: 'San Francisco', days: 1 }, runtime);
  const second = await executeTool('get_weather', { location: 'San Francisco', days: 1 }, runtime);
  assert.match(first.text, /San Francisco/);
  assert.equal(second.cacheHit, true);
  assert.equal(geocodeCalls, 1);
  assert.equal(forecastCalls, 1);
});
