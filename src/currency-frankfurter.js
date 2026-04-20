/**
 * Fiat currency conversion via Frankfurter (ECB rates, no API key).
 */

const BASE = 'https://api.frankfurter.app';

export async function convertCurrency(
  { amount = 1, from = 'USD', to = 'EUR' } = {},
  { fetchImpl = fetch, signal } = {}
) {
  const a = Number(amount);
  if (!Number.isFinite(a)) throw new Error('Invalid amount.');
  const f = String(from || 'USD').toUpperCase().slice(0, 3);
  const t = String(to || 'EUR').toUpperCase().slice(0, 3);
  if (f === t) {
    return {
      amount: a,
      from: f,
      to: t,
      result: a,
      rate: 1,
      text: `${a} ${f} = ${a} ${t}`
    };
  }
  const url = `${BASE}/latest?amount=${encodeURIComponent(String(a))}&from=${encodeURIComponent(f)}&to=${encodeURIComponent(t)}`;
  const r = await fetchImpl(url, { signal, headers: { Accept: 'application/json' } });
  if (!r.ok) {
    let detail = '';
    try {
      const text = await r.text();
      detail = text ? `: ${text.slice(0, 200)}` : '';
    } catch {
      detail = '';
    }
    throw new Error(`Currency service returned HTTP ${r.status}${detail}`);
  }
  const data = await r.json();
  const result = Number(data?.rates?.[t]);
  if (!Number.isFinite(result)) throw new Error('Could not convert currency.');
  const rate = a !== 0 ? result / a : null;
  return {
    amount: a,
    from: f,
    to: t,
    result,
    rate: Number.isFinite(rate) ? rate : null,
    date: data?.date || null,
    text: `${a} ${f} ≈ ${Number(result.toPrecision(12))} ${t}`
  };
}
