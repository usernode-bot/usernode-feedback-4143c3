const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const USERNODE_JWT_PUBLIC_KEY = process.env.USERNODE_JWT_PUBLIC_KEY;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const DAILY_ENERGY_LIMIT = 100;
const STARTING_COINS = 100;

// Energy regenerates continuously: one charge every REGEN_INTERVAL_SECONDS,
// up to ENERGY_CAP. There is no longer a daily reset — energy trickles back.
const ENERGY_CAP = 100;
const REGEN_INTERVAL_SECONDS = 30;
const REGEN_INTERVAL_MS = REGEN_INTERVAL_SECONDS * 1000;

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health', '/api/users/search', '/favicon.ico']);

// Per-user submission rate limit: one press per 6 seconds max.
const SUBMIT_COOLDOWN_MS = 6000;
const lastSubmitAt = new Map();

app.use(express.json());

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && USERNODE_JWT_PUBLIC_KEY) {
    try {
      const payload = jwt.verify(token, USERNODE_JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: 'usernode:app:' + process.env.USERNODE_APP_ID,
      });
      if (payload.pur === 'iframe') req.user = payload;
    } catch {}
  }
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Number of daily-energy presses this user has made since UTC midnight.
// Only source='daily' presses count against the daily cap.
async function getDailyPressCount(userId, client = pool) {
  const { rows } = await client.query(`
    SELECT COUNT(*) AS count
    FROM presses
    WHERE user_id = $1
      AND source = 'daily'
      AND created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
  `, [userId]);
  return parseInt(rows[0].count, 10);
}

// Energy locked in still-active listings created today.
async function getEscrowedToday(userId, client = pool) {
  const { rows } = await client.query(`
    SELECT COALESCE(SUM(remaining_amount), 0) AS escrowed
    FROM energy_listings
    WHERE seller_user_id = $1
      AND status = 'active'
      AND created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
  `, [userId]);
  return parseInt(rows[0].escrowed, 10);
}

// Daily energy still available to press or to sell.
async function getRemainingDaily(userId, client = pool) {
  const pressed = await getDailyPressCount(userId, client);
  const escrowed = await getEscrowedToday(userId, client);
  return DAILY_ENERGY_LIMIT - pressed - escrowed;
}

// Fetch (lazily creating) the user's wallet.
async function getWallet(user, client = pool) {
  await client.query(`
    INSERT INTO wallets (user_id, username, coins)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id) DO NOTHING
  `, [user.id, user.username, STARTING_COINS]);
  const { rows } = await client.query(
    `SELECT coins, purchased_energy FROM wallets WHERE user_id = $1`,
    [user.id]
  );
  return rows[0];
}

async function expireStaleListings(client = pool) {
  await client.query(`
    UPDATE energy_listings
    SET status = 'expired'
    WHERE status = 'active' AND expires_at <= NOW()
  `);
}

function nextUtcMidnight() {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

// Energy status — daily model: remaining = limit - today's press count.
app.get('/api/energy', async (req, res) => {
  try {
    if (IS_STAGING && req.query.demo === '1') {
      return res.json({
        energy: 7,
        cap: DAILY_ENERGY_LIMIT,
        full: false,
        resets_at: nextUtcMidnight(),
        purchased_energy: 3,
      });
    }
    const pressed = await getDailyPressCount(req.user.id);
    const energy = Math.max(0, DAILY_ENERGY_LIMIT - pressed);
    const wallet = await getWallet(req.user);
    res.json({
      energy,
      cap: DAILY_ENERGY_LIMIT,
      full: energy >= DAILY_ENERGY_LIMIT,
      resets_at: nextUtcMidnight(),
      purchased_energy: wallet.purchased_energy,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Button press. Uses daily energy first; falls back to purchased_energy.
app.post('/api/press', async (req, res) => {
  if (IS_STAGING && req.query.demo === '1') {
    return res.json({
      ok: true,
      energy: 6,
      cap: DAILY_ENERGY_LIMIT,
      full: false,
      resets_at: nextUtcMidnight(),
      purchased_energy: 3,
    });
  }

  const now = Date.now();
  const last = lastSubmitAt.get(req.user.id);
  if (last && now - last < SUBMIT_COOLDOWN_MS) {
    return res.status(429).json({ error: 'rate_limited' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const pressed = await getDailyPressCount(req.user.id, client);
    const dailyEnergy = DAILY_ENERGY_LIMIT - pressed;

    if (dailyEnergy > 0) {
      await client.query(
        `INSERT INTO presses (user_id, username, source) VALUES ($1, $2, 'daily')`,
        [req.user.id, req.user.username]
      );
      lastSubmitAt.set(req.user.id, now);
      const wallet = await getWallet(req.user, client);
      await client.query('COMMIT');
      return res.json({
        ok: true,
        energy: dailyEnergy - 1,
        cap: DAILY_ENERGY_LIMIT,
        full: false,
        resets_at: nextUtcMidnight(),
        purchased_energy: wallet.purchased_energy,
      });
    }

    // Daily energy exhausted — try purchased_energy from wallet.
    await client.query(`
      INSERT INTO wallets (user_id, username, coins) VALUES ($1, $2, $3)
      ON CONFLICT (user_id) DO NOTHING
    `, [req.user.id, req.user.username, STARTING_COINS]);
    const { rows } = await client.query(
      `SELECT coins, purchased_energy FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [req.user.id]
    );
    const wallet = rows[0];

    if (wallet.purchased_energy >= 1) {
      await client.query(
        `UPDATE wallets SET purchased_energy = purchased_energy - 1 WHERE user_id = $1`,
        [req.user.id]
      );
      await client.query(
        `INSERT INTO presses (user_id, username, source) VALUES ($1, $2, 'purchased')`,
        [req.user.id, req.user.username]
      );
      lastSubmitAt.set(req.user.id, now);
      await client.query('COMMIT');
      return res.json({
        ok: true,
        energy: 0,
        cap: DAILY_ENERGY_LIMIT,
        full: false,
        resets_at: nextUtcMidnight(),
        purchased_energy: wallet.purchased_energy - 1,
      });
    }

    await client.query('ROLLBACK');
    return res.status(429).json({
      error: 'no_energy',
      energy: 0,
      cap: DAILY_ENERGY_LIMIT,
      full: false,
      resets_at: nextUtcMidnight(),
      purchased_energy: 0,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Wallet balance
app.get('/api/wallet', async (req, res) => {
  try {
    const wallet = await getWallet(req.user);
    res.json({ coins: wallet.coins, purchased_energy: wallet.purchased_energy });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Leaderboard — all-time press totals. Also returns caller's rank if outside top 50.
app.get('/api/leaderboard', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT username, COUNT(*) AS presses
      FROM presses
      GROUP BY username
      ORDER BY presses DESC
      LIMIT 50
    `);

    const username = req.user.username;
    const inList = rows.some(r => r.username === username);

    let myRank = null;
    if (!inList) {
      const { rows: rankRows } = await pool.query(`
        SELECT u_rank, u_presses FROM (
          SELECT username,
            COUNT(*) AS u_presses,
            RANK() OVER (ORDER BY COUNT(*) DESC) AS u_rank
          FROM presses
          GROUP BY username
        ) sub
        WHERE sub.username = $1
      `, [username]);
      if (rankRows.length > 0) {
        myRank = {
          rank: parseInt(rankRows[0].u_rank, 10),
          presses: parseInt(rankRows[0].u_presses, 10),
        };
      }
    }

    res.json({ leaderboard: rows, my_rank: myRank, my_username: username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Active marketplace listings
app.get('/api/listings', async (req, res) => {
  try {
    await expireStaleListings();
    const { rows } = await pool.query(`
      SELECT id, seller_user_id, seller_username, unit_price, remaining_amount
      FROM energy_listings
      WHERE status = 'active' AND expires_at > NOW()
      ORDER BY unit_price ASC, created_at ASC
      LIMIT 100
    `);
    res.json({
      listings: rows.map((r) => ({
        id: r.id,
        seller_username: r.seller_username,
        unit_price: r.unit_price,
        remaining_amount: r.remaining_amount,
        is_mine: r.seller_user_id === req.user.id,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a sell listing — escrows energy out of today's pool.
app.post('/api/listings', async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const unitPrice = Number(req.body.unit_price);
    if (!Number.isInteger(amount) || amount < 1 ||
        !Number.isInteger(unitPrice) || unitPrice < 1) {
      return res.status(400).json({ error: 'invalid_input' });
    }

    const remainingDaily = await getRemainingDaily(req.user.id);
    if (amount > remainingDaily) {
      return res.status(400).json({ error: 'insufficient_energy', remaining_daily: remainingDaily });
    }

    const { rows } = await pool.query(`
      INSERT INTO energy_listings
        (seller_user_id, seller_username, unit_price, total_amount, remaining_amount, expires_at)
      VALUES ($1, $2, $3, $4, $4, $5)
      RETURNING id
    `, [req.user.id, req.user.username, unitPrice, amount, nextUtcMidnight()]);

    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Buy energy from a listing — atomic coin/energy transfer.
app.post('/api/listings/:id/buy', async (req, res) => {
  const listingId = parseInt(req.params.id, 10);
  const wantRaw = req.body.amount;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: listingRows } = await client.query(
      `SELECT * FROM energy_listings WHERE id = $1 FOR UPDATE`,
      [listingId]
    );
    const listing = listingRows[0];
    if (!listing || listing.status !== 'active' || new Date(listing.expires_at) <= new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'listing_unavailable' });
    }
    if (listing.seller_user_id === req.user.id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'cannot_buy_own' });
    }

    const amount = wantRaw == null ? listing.remaining_amount : Number(wantRaw);
    if (!Number.isInteger(amount) || amount < 1 || amount > listing.remaining_amount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'amount_unavailable', remaining_amount: listing.remaining_amount });
    }

    const cost = amount * listing.unit_price;

    await client.query(`
      INSERT INTO wallets (user_id, username, coins) VALUES ($1, $2, $3)
      ON CONFLICT (user_id) DO NOTHING
    `, [req.user.id, req.user.username, STARTING_COINS]);
    const { rows: buyerRows } = await client.query(
      `SELECT coins, purchased_energy FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [req.user.id]
    );
    const buyer = buyerRows[0];
    if (buyer.coins < cost) {
      await client.query('ROLLBACK');
      return res.status(402).json({ error: 'insufficient_coins', coins: buyer.coins });
    }

    await client.query(`
      INSERT INTO wallets (user_id, username, coins) VALUES ($1, $2, $3)
      ON CONFLICT (user_id) DO NOTHING
    `, [listing.seller_user_id, listing.seller_username, STARTING_COINS]);

    await client.query(
      `UPDATE wallets SET coins = coins - $1, purchased_energy = purchased_energy + $2 WHERE user_id = $3`,
      [cost, amount, req.user.id]
    );
    await client.query(
      `UPDATE wallets SET coins = coins + $1 WHERE user_id = $2`,
      [cost, listing.seller_user_id]
    );

    const newRemaining = listing.remaining_amount - amount;
    await client.query(
      `UPDATE energy_listings SET remaining_amount = $1, status = $2 WHERE id = $3`,
      [newRemaining, newRemaining === 0 ? 'sold_out' : 'active', listingId]
    );

    await client.query(`
      INSERT INTO energy_trades
        (listing_id, buyer_user_id, buyer_username, seller_user_id, seller_username, amount, unit_price, total_coins)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [listingId, req.user.id, req.user.username, listing.seller_user_id,
        listing.seller_username, amount, listing.unit_price, cost]);

    const { rows: finalRows } = await client.query(
      `SELECT coins, purchased_energy FROM wallets WHERE user_id = $1`,
      [req.user.id]
    );
    await client.query('COMMIT');
    res.json({
      ok: true,
      amount,
      coins: finalRows[0].coins,
      purchased_energy: finalRows[0].purchased_energy,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Cancel a listing — returns its unsold remainder to today's pool.
app.delete('/api/listings/:id', async (req, res) => {
  const listingId = parseInt(req.params.id, 10);
  try {
    const { rowCount } = await pool.query(
      `UPDATE energy_listings SET status = 'cancelled'
       WHERE id = $1 AND seller_user_id = $2 AND status = 'active'`,
      [listingId, req.user.id]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'not_found_or_not_yours' });
    }
    res.json({ ok: true });
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

async function seedStaging() {
  const fakes = [
    { id: -101, username: 'staging_alice', coins: 500, price: 2, amount: 30, presses: 85 },
    { id: -102, username: 'staging_bob',   coins: 250, price: 3, amount: 15, presses: 42 },
    { id: -103, username: 'staging_carol', coins: 999, price: 5, amount: 50, presses: 10 },
    { id: -104, username: 'staging_dave',  coins: 150, price: null, amount: null, presses: 7 },
    { id: -105, username: 'staging_eve',   coins: 75,  price: null, amount: null, presses: 3 },
  ];

  for (const f of fakes) {
    await pool.query(`
      INSERT INTO wallets (user_id, username, coins) VALUES ($1, $2, $3)
      ON CONFLICT (user_id) DO NOTHING
    `, [f.id, f.username, f.coins]);

    if (f.price && f.amount) {
      const { rows } = await pool.query(`
        SELECT COUNT(*) AS c FROM energy_listings
        WHERE seller_user_id = $1 AND status = 'active'
      `, [f.id]);
      if (parseInt(rows[0].c, 10) === 0) {
        await pool.query(`
          INSERT INTO energy_listings
            (seller_user_id, seller_username, unit_price, total_amount, remaining_amount, expires_at)
          VALUES ($1, $2, $3, $4, $4, $5)
        `, [f.id, f.username, f.price, f.amount, nextUtcMidnight()]);
      }
    }

    // Seed today's presses so these users appear on the leaderboard.
    const { rows: pressRows } = await pool.query(`
      SELECT COUNT(*) AS c FROM presses
      WHERE user_id = $1
        AND created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
    `, [f.id]);
    const existing = parseInt(pressRows[0].c, 10);
    if (existing < f.presses) {
      const toAdd = f.presses - existing;
      await pool.query(`
        INSERT INTO presses (user_id, username, source, created_at)
        SELECT $1, $2, 'daily', NOW()
        FROM generate_series(1, $3)
      `, [f.id, f.username, toAdd]);
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
  await pool.query(`
    ALTER TABLE presses ADD COLUMN IF NOT EXISTS source VARCHAR(16) NOT NULL DEFAULT 'daily'
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallets (
      user_id INTEGER PRIMARY KEY,
      username VARCHAR(255) NOT NULL,
      coins INTEGER NOT NULL DEFAULT ${STARTING_COINS},
      purchased_energy INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS energy_listings (
      id SERIAL PRIMARY KEY,
      seller_user_id INTEGER NOT NULL,
      seller_username VARCHAR(255) NOT NULL,
      unit_price INTEGER NOT NULL,
      total_amount INTEGER NOT NULL,
      remaining_amount INTEGER NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS energy_trades (
      id SERIAL PRIMARY KEY,
      listing_id INTEGER,
      buyer_user_id INTEGER NOT NULL,
      buyer_username VARCHAR(255) NOT NULL,
      seller_user_id INTEGER NOT NULL,
      seller_username VARCHAR(255) NOT NULL,
      amount INTEGER NOT NULL,
      unit_price INTEGER NOT NULL,
      total_coins INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Kept for backward compatibility; no longer read or written by active code.
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
    try { await seedStaging(); } catch (err) { console.error('staging seed failed', err); }
  }

  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
