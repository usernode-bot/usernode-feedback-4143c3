const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;

const DAILY_ENERGY_LIMIT = 500;

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health', '/api/active-event']);

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

// Active event — public so the banner can load before the user presses
app.get('/api/active-event', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT name, description, multiplier, ends_at
      FROM events
      WHERE starts_at <= NOW() AND ends_at >= NOW()
      ORDER BY multiplier DESC
      LIMIT 1
    `);
    res.json({ event: rows[0] || null });
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

// Button press
app.post('/api/press', async (req, res) => {
  try {
    const dailyCount = await getDailyPressCount(req.user.id);
    if (dailyCount >= DAILY_ENERGY_LIMIT) {
      return res.status(429).json({
        error: 'daily_limit_reached',
        remaining: 0,
        reset_at: nextUtcMidnight(),
      });
    }

    // Find the highest active event multiplier (default 1 if none active)
    const evtRes = await pool.query(`
      SELECT
        COALESCE(MAX(multiplier), 1) AS multiplier,
        MAX(name)                    AS name,
        COUNT(*) > 0                 AS active
      FROM events
      WHERE starts_at <= NOW() AND ends_at >= NOW()
    `);
    const eventMultiplier = parseInt(evtRes.rows[0].multiplier);
    const eventActive     = evtRes.rows[0].active;
    const eventName       = evtRes.rows[0].name || null;

    // Record the press with the current event multiplier
    await pool.query(`
      INSERT INTO presses (user_id, username, event_multiplier) VALUES ($1, $2, $3)
    `, [req.user.id, req.user.username, eventMultiplier]);

    // Upsert streak — same day: no change; yesterday: +1; older/first: reset to 1
    const streakRes = await pool.query(`
      INSERT INTO user_streaks (user_id, username, current_streak, longest_streak, last_press_date, updated_at)
      VALUES ($1, $2, 1, 1, (NOW() AT TIME ZONE 'UTC')::DATE, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        current_streak = CASE
          WHEN user_streaks.last_press_date = (NOW() AT TIME ZONE 'UTC')::DATE
            THEN user_streaks.current_streak
          WHEN user_streaks.last_press_date = (NOW() AT TIME ZONE 'UTC')::DATE - 1
            THEN user_streaks.current_streak + 1
          ELSE 1
        END,
        longest_streak = GREATEST(
          user_streaks.longest_streak,
          CASE
            WHEN user_streaks.last_press_date = (NOW() AT TIME ZONE 'UTC')::DATE
              THEN user_streaks.current_streak
            WHEN user_streaks.last_press_date = (NOW() AT TIME ZONE 'UTC')::DATE - 1
              THEN user_streaks.current_streak + 1
            ELSE 1
          END
        ),
        last_press_date = (NOW() AT TIME ZONE 'UTC')::DATE,
        username        = EXCLUDED.username,
        updated_at      = NOW()
      RETURNING current_streak, longest_streak
    `, [req.user.id, req.user.username]);

    const { current_streak, longest_streak } = streakRes.rows[0];
    res.json({ ok: true, current_streak, longest_streak, event_active: eventActive, event_name: eventName, event_multiplier: eventMultiplier, remaining: DAILY_ENERGY_LIMIT - (dailyCount + 1), reset_at: nextUtcMidnight() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Leaderboard — score = SUM(event_multiplier) × streak_multiplier_tier
app.get('/api/leaderboard', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        agg.username,
        ROUND(agg.base_score::numeric * CASE
          WHEN COALESCE(s.current_streak, 0) >= 30 THEN 2.0
          WHEN COALESCE(s.current_streak, 0) >= 14 THEN 1.5
          WHEN COALESCE(s.current_streak, 0) >= 7  THEN 1.25
          WHEN COALESCE(s.current_streak, 0) >= 3  THEN 1.1
          ELSE 1.0
        END) AS score,
        agg.raw_presses,
        COALESCE(s.current_streak, 0) AS current_streak
      FROM (
        SELECT user_id, MAX(username) AS username,
               SUM(event_multiplier)  AS base_score,
               COUNT(*)               AS raw_presses
        FROM presses
        GROUP BY user_id
      ) agg
      LEFT JOIN user_streaks s ON s.user_id = agg.user_id
      ORDER BY score DESC
      LIMIT 50
    `);
    res.json({ leaderboard: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Personal stats for the logged-in user
app.get('/api/my-stats', async (req, res) => {
  try {
    const [streakRes, pressRes, daysRes] = await Promise.all([
      pool.query(`
        SELECT
          current_streak,
          longest_streak,
          last_press_date = (NOW() AT TIME ZONE 'UTC')::DATE          AS pressed_today,
          last_press_date >= (NOW() AT TIME ZONE 'UTC')::DATE - 1     AS streak_active
        FROM user_streaks
        WHERE user_id = $1
      `, [req.user.id]),

      pool.query(`
        SELECT COUNT(*) AS raw_presses, COALESCE(SUM(event_multiplier), 0) AS base_score
        FROM presses
        WHERE user_id = $1
      `, [req.user.id]),

      // Last 7 UTC days + whether the user pressed on each
      pool.query(`
        WITH days AS (
          SELECT TO_CHAR(
            (NOW() AT TIME ZONE 'UTC')::DATE - generate_series(6, 0, -1),
            'YYYY-MM-DD'
          ) AS day
        ),
        pressed AS (
          SELECT DISTINCT TO_CHAR((created_at AT TIME ZONE 'UTC')::DATE, 'YYYY-MM-DD') AS day
          FROM presses
          WHERE user_id = $1
            AND (created_at AT TIME ZONE 'UTC')::DATE >= (NOW() AT TIME ZONE 'UTC')::DATE - 6
        )
        SELECT
          d.day,
          (pr.day IS NOT NULL) AS pressed,
          d.day = TO_CHAR((NOW() AT TIME ZONE 'UTC')::DATE, 'YYYY-MM-DD') AS is_today
        FROM days d
        LEFT JOIN pressed pr ON pr.day = d.day
        ORDER BY d.day
      `, [req.user.id]),
    ]);

    const streak       = streakRes.rows[0] || { current_streak: 0, longest_streak: 0, pressed_today: false, streak_active: false };
    const currentStreak = parseInt(streak.current_streak) || 0;
    const longestStreak = parseInt(streak.longest_streak) || 0;
    const baseScore     = parseInt(pressRes.rows[0].base_score) || 0;
    const rawPresses    = parseInt(pressRes.rows[0].raw_presses) || 0;

    const streakMult = currentStreak >= 30 ? 2.0
                     : currentStreak >= 14 ? 1.5
                     : currentStreak >= 7  ? 1.25
                     : currentStreak >= 3  ? 1.1 : 1.0;
    const score = Math.round(baseScore * streakMult);

    res.json({
      current_streak:  currentStreak,
      longest_streak:  longestStreak,
      pressed_today:   streak.pressed_today  || false,
      streak_active:   streak.streak_active  || false,
      raw_presses:     rawPresses,
      score,
      streak_days:     daysRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated, otherwise an "open in Usernode"
// landing page so stray visits to the staging/prod subdomain don't reveal the app.
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
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      username   VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE presses ADD COLUMN IF NOT EXISTS event_multiplier INTEGER NOT NULL DEFAULT 1
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(255) NOT NULL,
      description TEXT,
      multiplier  INTEGER NOT NULL DEFAULT 2,
      starts_at   TIMESTAMPTZ NOT NULL,
      ends_at     TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_streaks (
      user_id         INTEGER PRIMARY KEY,
      username        VARCHAR(255) NOT NULL,
      current_streak  INTEGER NOT NULL DEFAULT 0,
      longest_streak  INTEGER NOT NULL DEFAULT 0,
      last_press_date DATE,
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Seed the FIFA World Cup 2026 event so the bonus feature is visible immediately.
  // Uses WHERE NOT EXISTS so it only inserts once and is safe to replay on restarts.
  await pool.query(`
    INSERT INTO events (name, description, multiplier, starts_at, ends_at)
    SELECT
      '⚽ FIFA World Cup 2026',
      'World Cup fever! Every press earns 3× points during the tournament!',
      3,
      '2026-06-01 00:00:00+00',
      '2026-07-19 23:59:59+00'
    WHERE NOT EXISTS (
      SELECT 1 FROM events WHERE name = '⚽ FIFA World Cup 2026'
    )
  `);

  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
