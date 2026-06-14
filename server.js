const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;

const DAILY_ENERGY_LIMIT = 100;

// Daily activity scoring weights. Each press is worth PRESS_WEIGHT points and
// logging in (once per UTC day) is worth LOGIN_WEIGHT points. Tuned so showing
// up matters but an active day's presses still dominate.
const PRESS_WEIGHT = 1;
const LOGIN_WEIGHT = 10;

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

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

function nextUtcMidnight() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

async function getDailyPressCount(userId) {
  const { rows } = await pool.query(`
    SELECT COUNT(*) AS count
    FROM presses
    WHERE user_id = $1
      AND created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
  `, [userId]);
  return parseInt(rows[0].count, 10);
}

// Record a login credit for today's UTC day. Idempotent: the UNIQUE
// (user_id, day) constraint means repeated calls within the same day are
// cheap no-ops, so a user is credited at most once per day.
async function recordLogin(userId, username) {
  await pool.query(`
    INSERT INTO logins (user_id, username, day)
    VALUES ($1, $2, (NOW() AT TIME ZONE 'UTC')::date)
    ON CONFLICT (user_id, day) DO NOTHING
  `, [userId, username]);
}

// Record today's login (called on app load).
app.post('/api/login', async (req, res) => {
  try {
    await recordLogin(req.user.id, req.user.username);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Button press
app.post('/api/press', async (req, res) => {
  try {
    const count = await getDailyPressCount(req.user.id);
    if (count >= DAILY_ENERGY_LIMIT) {
      return res.status(429).json({
        error: 'daily_limit_reached',
        remaining: 0,
        reset_at: nextUtcMidnight(),
      });
    }
    // Any active presser is also logged in today; guarantee the credit even
    // if the load-time ping was missed.
    await recordLogin(req.user.id, req.user.username);
    await pool.query(`
      INSERT INTO presses (user_id, username) VALUES ($1, $2)
    `, [req.user.id, req.user.username]);
    res.json({ ok: true, remaining: DAILY_ENERGY_LIMIT - (count + 1) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Daily energy status
app.get('/api/energy', async (req, res) => {
  try {
    const count = await getDailyPressCount(req.user.id);
    res.json({
      remaining: DAILY_ENERGY_LIMIT - count,
      reset_at: nextUtcMidnight(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

// Daily activity leaderboard — combines today's presses and today's login
// credit into a single score per user. A full union over today's presses and
// logins ensures login-only users (0 presses) still appear with score
// LOGIN_WEIGHT. Aggregated on user_id so distinct users sharing a display
// name don't merge.
app.get('/api/leaderboard/daily', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      WITH today_presses AS (
        SELECT user_id, username, COUNT(*) AS presses
        FROM presses
        WHERE created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
        GROUP BY user_id, username
      ),
      today_logins AS (
        SELECT user_id, username, 1 AS logged_in
        FROM logins
        WHERE day = (NOW() AT TIME ZONE 'UTC')::date
      ),
      combined AS (
        SELECT
          COALESCE(p.user_id, l.user_id) AS user_id,
          COALESCE(p.username, l.username) AS username,
          COALESCE(p.presses, 0) AS presses,
          COALESCE(l.logged_in, 0) AS logged_in
        FROM today_presses p
        FULL OUTER JOIN today_logins l ON p.user_id = l.user_id
      )
      SELECT
        username,
        presses,
        logged_in,
        (presses * $1 + logged_in * $2) AS score
      FROM combined
      ORDER BY score DESC, presses DESC, username ASC
      LIMIT 50
    `, [PRESS_WEIGHT, LOGIN_WEIGHT]);
    res.json({ leaderboard: rows, reset_at: nextUtcMidnight() });
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

// Staging-only seed so the daily activity leaderboard isn't empty in a fresh
// PR preview (the new `logins` table starts empty, and same-day presses from
// multiple users are hard to reach by clicking around). Strictly no-op in
// production. Idempotent: logins rely on the UNIQUE (user_id, day) constraint,
// presses are only inserted when none exist yet today for that demo user.
async function seedStaging() {
  // Reserved fake id range, "Staging demo " usernames, a spread of press
  // counts including a login-only case (Eve: 0 presses -> score 10).
  const demo = [
    { id: 900001, name: 'Staging demo Ava', presses: 30 },
    { id: 900002, name: 'Staging demo Ben', presses: 18 },
    { id: 900003, name: 'Staging demo Cleo', presses: 12 },
    { id: 900004, name: 'Staging demo Dao', presses: 5 },
    { id: 900005, name: 'Staging demo Eve', presses: 0 },
  ];

  for (const u of demo) {
    // Login credit for today (idempotent via UNIQUE (user_id, day)).
    await pool.query(`
      INSERT INTO logins (user_id, username, day)
      VALUES ($1, $2, (NOW() AT TIME ZONE 'UTC')::date)
      ON CONFLICT (user_id, day) DO NOTHING
    `, [u.id, u.name]);

    // Today's presses, only if this demo user has none yet today, so reboots
    // don't pile up duplicates.
    if (u.presses > 0) {
      await pool.query(`
        INSERT INTO presses (user_id, username, created_at)
        SELECT $1, $2, NOW()
        FROM generate_series(1, $3)
        WHERE NOT EXISTS (
          SELECT 1 FROM presses
          WHERE user_id = $1
            AND created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
        )
      `, [u.id, u.name, u.presses]);
    }
  }
}

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS presses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // One row per user per UTC day — drives the daily activity login credit.
  // Public table (engagement data, no private content).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS logins (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      day DATE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, day)
    )
  `);

  if (IS_STAGING) await seedStaging();

  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
