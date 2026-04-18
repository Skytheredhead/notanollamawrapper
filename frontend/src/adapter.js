// ─── ADAPTER SELECTION ────────────────────────────────────────────────────────
// Set VITE_USE_MOCK=true in .env to use the local mock adapter.
// Both adapters implement the same interface — swap freely.

import mockAdapter from './mockAdapter'
import realAdapter from './api'

const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

const adapter = USE_MOCK ? mockAdapter : realAdapter

export default adapter
