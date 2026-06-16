const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const DAILY_ENERGY_LIMIT = 100;
const STARTING_COINS = 100;

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

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

function nextUtcMidnight() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

// Number of daily-energy presses this user has made since UTC midnight.
// Only `source='daily'` presses count against the daily cap — presses
// powered by purchased energy do not.
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

// Energy locked in this user's still-active listings created today. Selling
// energy escrows it out of today's pool immediately; cancelling a listing
// returns its unsold remainder.
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

// Fetch (lazily creating) the user's wallet. Seeds new wallets with the
// starting coin balance so buyers can transact on day one.
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

// Flip any listings whose expiry has passed to 'expired' so they stop
// trading and stop escrowing energy. Cheap to call before reads/writes.
async function expireStaleListings(client = pool) {
  await client.query(`
    UPDATE energy_listings
    SET status = 'expired'
    WHERE status = 'active' AND expires_at <= NOW()
  `);
}

// Button press
app.post('/api/press', async (req, res) => {
  const client = await pool.connect();
  try {
    const now = Date.now();
    const last = lastSubmitAt.get(req.user.id);
    if (last && now - last < SUBMIT_COOLDOWN_MS) {
      const retryAfterMs = SUBMIT_COOLDOWN_MS - (now - last);
      res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      return res.status(429).json({
        error: 'You\'re submitting too fast. Please wait a moment before submitting again.',
        retryAfterMs,
      });
    }
    lastSubmitAt.set(req.user.id, now);

    await client.query('BEGIN');
    const remainingDaily = await getRemainingDaily(req.user.id, client);

    if (remainingDaily > 0) {
      // Spend daily energy first.
      await client.query(
        `INSERT INTO presses (user_id, username, source) VALUES ($1, $2, 'daily')`,
        [req.user.id, req.user.username]
      );
    } else {
      // Fall back to purchased energy (lets the user press beyond the cap).
      const wallet = await getWallet(req.user, client);
      if (wallet.purchased_energy > 0) {
        await client.query(
          `UPDATE wallets SET purchased_energy = purchased_energy - 1 WHERE user_id = $1`,
          [req.user.id]
        );
        await client.query(
          `INSERT INTO presses (user_id, username, source) VALUES ($1, $2, 'purchased')`,
          [req.user.id, req.user.username]
        );
      } else {
        await client.query('ROLLBACK');
        return res.status(429).json({
          error: 'daily_limit_reached',
          remaining_daily: 0,
          purchased_energy: 0,
          reset_at: nextUtcMidnight(),
        });
      }
    }

    const wallet = await getWallet(req.user, client);
    const newRemaining = await getRemainingDaily(req.user.id, client);
    await client.query('COMMIT');
    res.json({
      ok: true,
      remaining_daily: newRemaining,
      purchased_energy: wallet.purchased_energy,
      reset_at: nextUtcMidnight(),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Daily energy status
app.get('/api/energy', async (req, res) => {
  try {
    const remaining = await getRemainingDaily(req.user.id);
    const wallet = await getWallet(req.user);
    res.json({
      remaining,
      purchased_energy: wallet.purchased_energy,
      reset_at: nextUtcMidnight(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

    // Default to buying the whole listing when no amount is supplied.
    const amount = wantRaw == null ? listing.remaining_amount : Number(wantRaw);
    if (!Number.isInteger(amount) || amount < 1 || amount > listing.remaining_amount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'amount_unavailable', remaining_amount: listing.remaining_amount });
    }

    const cost = amount * listing.unit_price;

    // Lock + ensure buyer wallet.
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

    // Ensure seller wallet exists, then credit it.
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

// Leaderboard — counts all presses (daily + purchased).
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

async function seedStaging() {
  // Give the marketplace some life on a fresh staging container. Public
  // tables copy prod rows into staging, but these fake sellers may not be
  // present, so (re)seed idempotently behind sentinel user ids.
  const fakes = [
    { id: -101, username: 'staging_alice', coins: 500, price: 2, amount: 30 },
    { id: -102, username: 'staging_bob', coins: 250, price: 3, amount: 15 },
    { id: -103, username: 'staging_carol', coins: 999, price: 5, amount: 50 },
  ];
  for (const f of fakes) {
    await pool.query(`
      INSERT INTO wallets (user_id, username, coins) VALUES ($1, $2, $3)
      ON CONFLICT (user_id) DO NOTHING
    `, [f.id, f.username, f.coins]);
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
  // Track which energy pool powered each press. 'daily' counts against the
  // daily cap; 'purchased' is spent from bought energy and does not.
  await pool.query(`
    ALTER TABLE presses ADD COLUMN IF NOT EXISTS source VARCHAR(16) NOT NULL DEFAULT 'daily'
  `);

  // In-app currency + bought energy balance. Public: holds play-money only,
  // and the leaderboard already exposes per-user activity.
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

  if (IS_STAGING) {
    try { await seedStaging(); } catch (err) { console.error('staging seed failed', err); }
  }

  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
