// ─── ADAPTER SELECTION ────────────────────────────────────────────────────────
// Set VITE_USE_MOCK=false in .env to use the real backend.
// Both adapters implement the same interface — swap freely.

import mockAdapter from './mockAdapter'
import realAdapter from './api'

const USE_MOCK = import.meta.env.VITE_USE_MOCK !== 'false'

const adapter = USE_MOCK ? mockAdapter : realAdapter

export default adapter
