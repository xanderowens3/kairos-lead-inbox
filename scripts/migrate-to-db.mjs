/* One-time import: push the existing flat JSON files into Postgres.
   Run with the DB env set:  node --env-file=.env scripts/migrate-to-db.mjs   */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, usingDb, closeDb,
         getOffers, saveOffers, getLeads, saveLeads, getProfiles, saveProfiles } from '../db.mjs';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const read = async (f, fb) => { try { return JSON.parse(await readFile(join(DATA, f), 'utf8')); } catch { return fb; } };

if (!usingDb){
  console.error('DATABASE_URL is not set — run with:  node --env-file=.env scripts/migrate-to-db.mjs');
  process.exit(1);
}

await initDb();

const offers   = await read('offers.json', []);
const leads    = await read('leads.json', []);
const profiles = await read('profiles.json', {});

console.log(`read from disk → ${offers.length} offers, ${leads.length} leads, ${Object.keys(profiles).length} profiles`);

await saveOffers(offers);
await saveLeads(leads);
await saveProfiles(profiles);

// verify by reading back out of Postgres
const [o, l, p] = [await getOffers(), await getLeads(), await getProfiles()];
console.log(`in Postgres now → ${o.length} offers, ${l.length} leads, ${Object.keys(p).length} profiles`);
console.log(o.length === offers.length && l.length === leads.length ? '✓ counts match' : '✗ COUNT MISMATCH — check output');

await closeDb();
process.exit(0);
