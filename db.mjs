/* ==========================================================================
   Storage layer. Uses Postgres (Supabase) when DATABASE_URL is set, and falls
   back to the flat JSON files in data/ when it isn't — so local dev works
   offline and nothing breaks mid-migration.

   Offers and leads are stored one row per document (id + jsonb), with a few
   TEXT columns generated from the JSON so the Supabase table editor is readable
   and the app's data model stays intact. Profiles are the enrichment cache,
   keyed by LinkedIn URL (a null value means "looked up, no data" — still cached).
   ========================================================================== */
import pkg from 'pg';
const { Pool } = pkg;
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE      = dirname(fileURLToPath(import.meta.url));
const OFFERS    = join(HERE, 'data', 'offers.json');
const LEADS     = join(HERE, 'data', 'leads.json');
const PROFILES  = join(HERE, 'data', 'profiles.json');
const SCHEDULES = join(HERE, 'data', 'schedules.json');
const RUNS      = join(HERE, 'data', 'runs.json');

export const usingDb = !!process.env.DATABASE_URL;

let pool = null;

export async function initDb(){
  if (!usingDb) return false;
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },   // Supabase requires SSL
    max: 5
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS offers (
      id text PRIMARY KEY,
      data jsonb NOT NULL,
      name text GENERATED ALWAYS AS (data->>'name') STORED,
      seq bigserial,
      updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS leads (
      id text PRIMARY KEY,
      data jsonb NOT NULL,
      author text GENERATED ALWAYS AS (data->>'author') STORED,
      score text GENERATED ALWAYS AS (data->>'score') STORED,
      recommend text GENERATED ALWAYS AS (data->>'recommend') STORED,
      offer_name text GENERATED ALWAYS AS (data->>'offerName') STORED,
      icp_name text GENERATED ALWAYS AS (data->>'icpName') STORED,
      reason text GENERATED ALWAYS AS (data->>'reason') STORED,
      analyzed_at text GENERATED ALWAYS AS (data->>'analyzedAt') STORED,
      seq bigserial,
      updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS profiles (
      url text PRIMARY KEY,
      data jsonb,
      updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS locks (
      id text PRIMARY KEY,
      owner text NOT NULL,
      expires_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id text PRIMARY KEY,
      data jsonb NOT NULL,
      icp_name text GENERATED ALWAYS AS (data->>'icpName') STORED,
      state text GENERATED ALWAYS AS (data->>'state') STORED,
      started_at text GENERATED ALWAYS AS (data->>'startedAt') STORED,
      scored text GENERATED ALWAYS AS (data->>'scored') STORED,
      recommended text GENERATED ALWAYS AS (data->>'recommended') STORED,
      error text GENERATED ALWAYS AS (data->>'error') STORED,
      seq bigserial,
      updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id text PRIMARY KEY,
      data jsonb NOT NULL,
      name text GENERATED ALWAYS AS (data->>'name') STORED,
      offer_name text GENERATED ALWAYS AS (data->>'offerName') STORED,
      status text GENERATED ALWAYS AS (data->>'status') STORED,
      next_run text GENERATED ALWAYS AS (data->>'nextRun') STORED,
      seq bigserial,
      updated_at timestamptz DEFAULT now()
    );
  `);
  return true;
}

export async function closeDb(){ if (pool) await pool.end(); }

/* ---------- flat-file fallback ---------- */
const loadJSON = async (path, fallback) => {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
};
const saveJSON = async (path, data) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), 'utf8');
};

/* ---------- array stores (offers, leads) ----------
   The client always GETs / PUTs the whole array, so save makes the table match
   the array exactly: upsert what's present, delete what's gone. Insertion order
   is preserved via seq. */
async function getArray(table, path){
  if (!usingDb) return loadJSON(path, []);
  const { rows } = await pool.query(`SELECT data FROM ${table} ORDER BY seq`);
  return rows.map(r => r.data);
}
async function saveArray(table, path, arr){
  if (!usingDb) return saveJSON(path, arr);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = arr.map(x => x.id);
    if (ids.length) await client.query(`DELETE FROM ${table} WHERE id <> ALL($1::text[])`, [ids]);
    else            await client.query(`DELETE FROM ${table}`);
    for (const item of arr){
      await client.query(
        `INSERT INTO ${table} (id, data) VALUES ($1, $2::jsonb)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [item.id, JSON.stringify(item)]
      );
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

export const getOffers    = ()    => getArray('offers', OFFERS);
export const saveOffers   = arr  => saveArray('offers', OFFERS, arr);
export const getLeads     = ()    => getArray('leads', LEADS);
export const saveLeads    = arr  => saveArray('leads', LEADS, arr);
export const getSchedules = ()    => getArray('schedules', SCHEDULES);
export const saveSchedules= arr  => saveArray('schedules', SCHEDULES, arr);
export const getRuns      = ()    => getArray('runs', RUNS);
export const saveRuns     = arr  => saveArray('runs', RUNS, arr);

/* ---------- scheduler lease ----------
   Only one process may run the scheduler. Without this, two of them — a Railway
   redeploy briefly overlapping, or a second server pointed at the same database —
   both see a schedule as due and both act on it: two Trigify searches get created
   for one ICP, and because each writes the WHOLE schedules array from its own
   in-memory copy, whichever finishes last erases the other's run state.

   The lease is taken atomically in Postgres. It is renewed on every tick and
   outlives a long run, so a crashed holder is replaced within LEASE_MINUTES. */
const LEASE_MINUTES = 10;
export async function acquireSchedulerLease(owner){
  if (!usingDb) return true;                    // single process when file-backed
  const { rows } = await pool.query(
    `INSERT INTO locks (id, owner, expires_at)
     VALUES ('scheduler', $1, now() + ($2 || ' minutes')::interval)
     ON CONFLICT (id) DO UPDATE SET owner = $1, expires_at = now() + ($2 || ' minutes')::interval
     WHERE locks.owner = $1 OR locks.expires_at < now()
     RETURNING owner`,
    [owner, String(LEASE_MINUTES)]
  );
  return rows.length > 0;                       // no row → someone else holds it
}
export async function releaseSchedulerLease(owner){
  if (!usingDb) return;
  try { await pool.query(`DELETE FROM locks WHERE id='scheduler' AND owner=$1`, [owner]); } catch {}
}

/* Append one run to the logbook, newest last, keeping the most recent 200. */
export async function addRun(run){
  const all = await getRuns();
  all.push(run);
  return saveRuns(all.slice(-200));
}

/* ---------- profile cache (keyed by URL, null = looked-up-empty) ---------- */
export async function getProfiles(){
  if (!usingDb) return loadJSON(PROFILES, {});
  const { rows } = await pool.query('SELECT url, data FROM profiles');
  const out = {};
  for (const r of rows) out[r.url] = r.data;   // r.data may be JSON null
  return out;
}
export async function saveProfiles(obj){
  if (!usingDb) return saveJSON(PROFILES, obj);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [url, prof] of Object.entries(obj)){
      await client.query(
        `INSERT INTO profiles (url, data) VALUES ($1, $2::jsonb)
         ON CONFLICT (url) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [url, JSON.stringify(prof ?? null)]
      );
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
