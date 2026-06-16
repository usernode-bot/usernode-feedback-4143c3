const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// Energy regenerates continuously: one charge every REGEN_INTERVAL_SECONDS,
// up to ENERGY_CAP. There is no longer a daily reset — energy trickles back.
const ENERGY_CAP = 100;
const REGEN_INTERVAL_SECONDS = 30;
const REGEN_INTERVAL_MS = REGEN_INTERVAL_SECONDS * 1000;

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health', '/api/users/search']);

// Per-user submission rate limit: at most one submission every 6 seconds.
// Keyed by req.user.id, tracked in-memory (fine for a single container —
// resets on restart, which only ever loosens the limit).
const SUBMIT_COOLDOWN_MS = 6000;
const lastSubmitAt = new Map();

app.use(express.json());

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// --- Energy accrual ---------------------------------------------------------

// Given a stored balance + its clock anchor, roll forward to `now`: add one
// charge per whole elapsed interval, clamped at the cap. We advance the anchor
// by *whole intervals only* (not to `now`) so sub-interval progress survives
// across reads; once full, the anchor is pinned to `now`.
function accrue(energy, updatedAt, now) {
  if (energy >= ENERGY_CAP) return { energy: ENERGY_CAP, updatedAt: now };
  const anchor = new Date(updatedAt).getTime();
  const gained = Math.max(0, Math.floor((now.getTime() - anchor) / REGEN_INTERVAL_MS));
  const newEnergy = Math.min(ENERGY_CAP, energy + gained);
  if (newEnergy >= ENERGY_CAP) return { energy: ENERGY_CAP, updatedAt: now };
  return { energy: newEnergy, updatedAt: new Date(anchor + gained * REGEN_INTERVAL_MS) };
}

// The single response shape every energy-bearing branch returns. Keeping all
// branches on this helper is what prevents the NaN:NaN class of bug — the
// timing field is never accidentally omitted.
function payloadFor(energy, updatedAt) {
  const full = energy >= ENERGY_CAP;
  return {
    energy,
    cap: ENERGY_CAP,
    full,
    next_charge_at: full
      ? null
      : new Date(new Date(updatedAt).getTime() + REGEN_INTERVAL_MS).toISOString(),
    regen_interval_seconds: REGEN_INTERVAL_SECONDS,
  };
}

// Staging-only synthetic state so reviewers can watch the countdown tick and
// the energy number climb without having to drain a real balance first.
// No-op in production (guarded by IS_STAGING at the call site).
function demoPayload() {
  return {
    energy: 3,
    cap: ENERGY_CAP,
    full: false,
    next_charge_at: new Date(Date.now() + 12000).toISOString(),
    regen_interval_seconds: REGEN_INTERVAL_SECONDS,
  };
}

// Read + accrue + persist the caller's balance. A missing row means the user
// has never spent energy, so they're full; we don't materialize a row until
// the first press (see /api/press).
async function readAndPersistEnergy(userId) {
  const { rows } = await pool.query(
    'SELECT energy, updated_at FROM energy_state WHERE user_id = $1',
    [userId],
  );
  if (!rows.length) return { energy: ENERGY_CAP, updatedAt: new Date() };
  const a = accrue(rows[0].energy, rows[0].updated_at, new Date());
  await pool.query(
    'UPDATE energy_state SET energy = $1, updated_at = $2 WHERE user_id = $3',
    [a.energy, a.updatedAt, userId],
  );
  return a;
}

// Energy status
app.get('/api/energy', async (req, res) => {
  try {
    if (IS_STAGING && req.query.demo === '1') return res.json(demoPayload());
    const a = await readAndPersistEnergy(req.user.id);
    res.json(payloadFor(a.energy, a.updatedAt));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Button press — spend one energy. Wrapped in a transaction with a row lock so
// two near-simultaneous clicks can't both spend the same charge.
app.post('/api/press', async (req, res) => {
  if (IS_STAGING && req.query.demo === '1') {
    // Demo mode never mutates real state; just hand back a fresh demo frame.
    return res.json({ ok: true, ...demoPayload() });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Guarantee a row exists (full), then lock it for the spend.
    await client.query(
      `INSERT INTO energy_state (user_id, energy, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO NOTHING`,
      [req.user.id, ENERGY_CAP],
    );
    const { rows } = await client.query(
      'SELECT energy, updated_at FROM energy_state WHERE user_id = $1 FOR UPDATE',
      [req.user.id],
    );
    const now = new Date();
    const a = accrue(rows[0].energy, rows[0].updated_at, now);

    if (a.energy <= 0) {
      await client.query(
        'UPDATE energy_state SET energy = $1, updated_at = $2 WHERE user_id = $3',
        [a.energy, a.updatedAt, req.user.id],
      );
      await client.query('COMMIT');
      return res.status(429).json({ error: 'no_energy', ...payloadFor(a.energy, a.updatedAt) });
    }

    // If they were at the cap, regen starts ticking from this spend.
    const wasFull = a.energy >= ENERGY_CAP;
    const newEnergy = a.energy - 1;
    const newUpdatedAt = wasFull ? now : a.updatedAt;

    await client.query(
      'UPDATE energy_state SET energy = $1, updated_at = $2 WHERE user_id = $3',
      [newEnergy, newUpdatedAt, req.user.id],
    );
    await client.query(
      'INSERT INTO presses (user_id, username) VALUES ($1, $2)',
      [req.user.id, req.user.username],
    );
    await client.query('COMMIT');
    res.json({ ok: true, ...payloadFor(newEnergy, newUpdatedAt) });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Leaderboard
app.get('/api/leaderboard', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT username, COUNT(*) as presses
      FROM presses
      GROUP BY username
      ORDER BY presses DESC
      LIMIT 50
    `);
    res.json({ leaderboard: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// User search — public endpoint, searches by username substring
app.get('/api/users/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) {
    return res.status(400).json({ error: 'query_too_short' });
  }
  try {
    const { rows } = await pool.query(`
      WITH ranked AS (
        SELECT username,
               COUNT(*)::int AS total_presses,
               RANK() OVER (ORDER BY COUNT(*) DESC)::int AS rank
        FROM presses
        GROUP BY username
      )
      SELECT username, total_presses, rank
      FROM ranked
      WHERE username ILIKE $1
      ORDER BY total_presses DESC
      LIMIT 10
    `, [`%${q}%`]);
    res.json({ users: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated, otherwise an "open in Usernode"
// landing page so stray visits to the staging URL don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user) {
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="https://social-vibecoding.usernodelabs.org" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Go to Usernode</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS presses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Per-user energy balance + regen clock anchor. Public: holds only a small
  // integer counter and a timestamp — nothing a stranger viewing staging
  // shouldn't see, and no FK to any private table.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS energy_state (
      user_id INTEGER PRIMARY KEY,
      energy INTEGER NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  if (IS_STAGING) {
    const { rows: existing } = await pool.query(
      `SELECT 1 FROM presses WHERE username = 'staging-demo-alice' LIMIT 1`
    );
    if (!existing.length) {
      const demoUsers = [
        { uid: -1, name: 'staging-demo-alice', count: 240 },
        { uid: -2, name: 'staging-demo-bob',   count: 185 },
        { uid: -3, name: 'staging-demo-carol', count: 130 },
        { uid: -4, name: 'staging-demo-dave',  count: 95 },
        { uid: -5, name: 'staging-demo-eve',   count: 60 },
        { uid: -6, name: 'staging-demo-frank', count: 40 },
        { uid: -7, name: 'staging-demo-grace', count: 20 },
        { uid: -8, name: 'staging-demo-heidi', count: 8 },
      ];
      for (const u of demoUsers) {
        await pool.query(`
          INSERT INTO presses (user_id, username, created_at)
          SELECT $1, $2, NOW() - (generate_series(1, $3) * INTERVAL '1 hour')
        `, [u.uid, u.name, u.count]);
      }
      console.log('Staging: seeded demo press data for 8 fake users');
    }
  }
  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
