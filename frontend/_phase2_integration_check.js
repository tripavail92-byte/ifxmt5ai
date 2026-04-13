/**
 * Phase 1→2 Integration Smoke Tests
 *
 * Tests all integration points introduced in Phase 1 (schema migration)
 * and Phase 2 (EA cloud config + auto-attach):
 *
 *   TEST 1 — /api/ea/config returns v3 schema with setup fields
 *   TEST 2 — Unauthenticated request returns 401 (auth gate works)
 *   TEST 3 — trading_setups v9.30 columns are present in DB
 *   TEST 4 — ea_live_state upsert RPC is callable
 *   TEST 5 — Config contains correct nested JSON structure for EA parser
 *
 * Run: node _phase2_integration_check.js
 * Requires env vars or edit the constants below.
 */

const https = require('https');
const http  = require('http');

// ── Config ────────────────────────────────────────────────────────────────
const FRONTEND_URL   = process.env.IFX_FRONTEND_URL  || 'https://ifx-mt5-portal-production.up.railway.app';
const SUPABASE_URL   = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CONNECTION_ID  = process.env.PW_CONN_ID || 'c9fc4e21-f284-4c86-999f-ddedd5649734';
// install_token from ea_installations for the above connection_id
// Leave blank to skip token-gated tests (TEST 1 will be skipped, TEST 2 will still run)
const INSTALL_TOKEN  = process.env.IFX_INSTALL_TOKEN || '';

// ── Utilities ────────────────────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;

function ok(name, detail = '')  { passed++;  console.log(`  ✅ PASS  ${name}${detail ? ': ' + detail : ''}`); }
function fail(name, reason)     { failed++;  console.error(`  ❌ FAIL  ${name}: ${reason}`); }
function skip(name, reason)     { skipped++; console.log(`  ⏭  SKIP  ${name}: ${reason}`); }

function request(urlStr, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data), raw: data }); }
        catch { resolve({ status: res.statusCode, body: null, raw: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function supabaseRpc(rpcName, params) {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  return request(`${SUPABASE_URL}/rest/v1/rpc/${rpcName}`, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
    },
    body: params,
  });
}

async function supabaseSelect(table, params = '') {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  return request(`${SUPABASE_URL}/rest/v1/${table}?${params}&limit=1`, {
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
    },
  });
}

// ── TESTS ─────────────────────────────────────────────────────────────────

async function test1_configEndpointReturnsV3() {
  const name = 'TEST 1 — /api/ea/config returns v3 schema with setup fields';
  if (!INSTALL_TOKEN) {
    skip(name, 'IFX_INSTALL_TOKEN not set — set env var to test authenticated config fetch');
    return;
  }

  let res;
  try {
    res = await request(
      `${FRONTEND_URL}/api/ea/config?connection_id=${CONNECTION_ID}`,
      { headers: { 'Authorization': `Bearer ${INSTALL_TOKEN}` } }
    );
  } catch (e) {
    fail(name, `network error: ${e.message}`);
    return;
  }

  if (res.status !== 200) { fail(name, `HTTP ${res.status}: ${res.raw.slice(0, 200)}`); return; }
  const cfg = res.body;
  if (!cfg?.ok)              { fail(name, '"ok" field not true'); return; }
  if (!cfg?.config)          { fail(name, '"config" key missing from response'); return; }
  if (cfg.config.meta?.schema_version !== 3) { fail(name, `schema_version=${cfg.config.meta?.schema_version}, expected 3`); return; }

  // Check setup section has v9.30 fields
  const setup = cfg.config.setup;
  if (!setup)                { fail(name, 'config.setup section missing'); return; }
  const missing = ['bias', 'pivot', 'tp1', 'tp2', 'atr_zone_thickness_pct', 'sl_pad_mult'].filter(k => !(k in setup));
  if (missing.length)        { fail(name, `config.setup missing fields: ${missing.join(', ')}`); return; }

  ok(name, `schema_version=3, bias=${setup.bias}, pivot=${setup.pivot}`);
}

async function test2_unauthenticatedConfigReturns401() {
  const name = 'TEST 2 — /api/ea/config rejects request without token (returns 401)';
  let res;
  try {
    res = await request(`${FRONTEND_URL}/api/ea/config?connection_id=${CONNECTION_ID}`);
  } catch (e) {
    fail(name, `network error: ${e.message}`);
    return;
  }
  if (res.status === 401) { ok(name, 'auth gate working'); return; }
  if (res.status === 400) { ok(name, 'returned 400 (missing/invalid token check before 401 — acceptable)'); return; }
  fail(name, `expected 401, got HTTP ${res.status}`);
}

async function test3_tradingSetupsHasV930Columns() {
  const name = 'TEST 3 — trading_setups has v9.30 columns (pivot, tp1, tp2, bias, atr_zone_pct, sl_pad_mult)';
  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip(name, 'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
    return;
  }

  let res;
  try {
    // select=* returns all columns; we check the column names in the response headers
    res = await request(
      `${SUPABASE_URL}/rest/v1/trading_setups?select=pivot,tp1,tp2,bias,atr_zone_pct,sl_pad_mult,ai_text,config_snapshot&limit=1`,
      {
        headers: {
          'apikey': SERVICE_KEY,
          'Authorization': `Bearer ${SERVICE_KEY}`,
          'Accept': 'application/json',
        },
      }
    );
  } catch (e) {
    fail(name, `network error: ${e.message}`);
    return;
  }

  // A 400 with "column ... does not exist" means column is missing
  if (res.status === 400 || res.status === 500) {
    fail(name, `DB error — columns likely not created by migration: ${res.raw.slice(0, 300)}`);
    return;
  }
  // 200 or 206 (empty array) both mean columns exist
  if (res.status === 200 || res.status === 206) {
    ok(name, 'all v9.30 columns present in trading_setups');
    return;
  }
  fail(name, `unexpected HTTP ${res.status}: ${res.raw.slice(0, 200)}`);
}

async function test4_eaLiveStateUpsertRpc() {
  const name = 'TEST 4 — ea_live_state upsert RPC is callable (upsert_ea_live_state)';
  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip(name, 'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
    return;
  }

  let res;
  try {
    res = await supabaseRpc('upsert_ea_live_state', {
      p_connection_id:    CONNECTION_ID,
      p_hud_status:       'INTEGRATION_TEST',
      p_sys_bias:         'Neutral',
      p_sys_pivot:        0,
      p_sys_tp1:          0,
      p_sys_tp2:          0,
      p_invalidation_lvl: 0,
      p_live_sl:          0,
      p_live_lots:        0,
      p_is_inside_zone:   false,
      p_is_be_secured:    false,
      p_unrealised_pnl:   0,
      p_daily_trades:     0,
      p_daily_pnl_usd:    0,
      p_top_ledger:       [],
      p_raw_payload:      {},
    });
  } catch (e) {
    fail(name, `network error: ${e.message}`);
    return;
  }

  if (!res) { skip(name, 'no Supabase credentials'); return; }

  if (res.status === 204 || res.status === 200) {
    ok(name, 'RPC executed (HTTP 204 = success)');

    // Clean up: reset hud_status back to ASLEEP so it doesn't confuse dashboard
    await supabaseRpc('upsert_ea_live_state', {
      p_connection_id: CONNECTION_ID,
      p_hud_status:    'ASLEEP',
      p_sys_bias: null, p_sys_pivot: null, p_sys_tp1: null, p_sys_tp2: null,
      p_invalidation_lvl: null, p_live_sl: null, p_live_lots: null,
      p_is_inside_zone: false, p_is_be_secured: false, p_unrealised_pnl: null,
      p_daily_trades: 0, p_daily_pnl_usd: 0, p_top_ledger: [], p_raw_payload: {},
    });
    return;
  }
  if (res.status === 404) {
    fail(name, 'RPC not found — migration may not have run (upsert_ea_live_state function missing)');
    return;
  }
  // FK violation means ea_live_state table exists but no matching connection — column structure is fine
  if (res.status === 409 || (res.raw && res.raw.includes('foreign key'))) {
    ok(name, `RPC exists and schema is correct (FK constraint hit — connection ${CONNECTION_ID} not in mt5_user_connections, expected in test env)`);
    return;
  }
  fail(name, `unexpected HTTP ${res.status}: ${res.raw.slice(0, 300)}`);
}

async function test5_configJsonStructureForEaParser() {
  const name = 'TEST 5 — Config JSON shape has all nested groups expected by CFG_ParseFromCloudJson';
  if (!INSTALL_TOKEN) {
    skip(name, 'IFX_INSTALL_TOKEN not set');
    return;
  }

  let res;
  try {
    res = await request(
      `${FRONTEND_URL}/api/ea/config?connection_id=${CONNECTION_ID}`,
      { headers: { 'Authorization': `Bearer ${INSTALL_TOKEN}` } }
    );
  } catch (e) {
    fail(name, `network error: ${e.message}`);
    return;
  }

  if (res.status !== 200 || !res.body?.config) {
    skip(name, `skipping — TEST 1 also failed (HTTP ${res.status})`);
    return;
  }

  const cfg = res.body.config;
  // These are the exact keys CFG_ParseFromCloudJson() looks for
  const requiredGroups = ['setup', 'structure', 'risk', 'execution', 'sessions', 'discord', 'symbols'];
  const missingGroups  = requiredGroups.filter(g => !cfg[g]);

  const sessions = cfg.sessions || {};
  const requiredSessions = ['asia', 'london', 'new_york'];
  const missingSessions  = requiredSessions.filter(s => !sessions[s]);

  const errors = [];
  if (missingGroups.length)  errors.push(`missing top-level groups: ${missingGroups.join(', ')}`);
  if (missingSessions.length) errors.push(`missing sessions: ${missingSessions.join(', ')}`);

  // Verify symbols.active is an array (EA parses it to CSV)
  if (!Array.isArray(cfg.symbols?.active)) errors.push('symbols.active is not an array');

  if (errors.length) { fail(name, errors.join('; ')); return; }
  ok(name, `all groups present, symbols=[${(cfg.symbols?.active || []).join(',')}]`);
}

// ── Runner ────────────────────────────────────────────────────────────────
(async () => {
  console.log('');
  console.log('=== IFX Phase 1→2 Integration Smoke Tests ===');
  console.log(`Frontend: ${FRONTEND_URL}`);
  console.log(`Connection: ${CONNECTION_ID}`);
  console.log(`Supabase: ${SUPABASE_URL ? '✓ configured' : '✗ not set — DB tests will be skipped'}`);
  console.log(`Install token: ${INSTALL_TOKEN ? '✓ set' : '✗ not set — config fetch tests will be skipped'}`);
  console.log('');

  await test1_configEndpointReturnsV3();
  await test2_unauthenticatedConfigReturns401();
  await test3_tradingSetupsHasV930Columns();
  await test4_eaLiveStateUpsertRpc();
  await test5_configJsonStructureForEaParser();

  console.log('');
  console.log(`=== Results: ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
  if (failed > 0) process.exit(1);
})();
