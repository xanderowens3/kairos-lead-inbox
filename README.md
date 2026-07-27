# Kairos — AI Lead Inbox

An AI agent that turns [Trigify](https://trigify.io) social listening into a qualified lead inbox.

You define an **Offer** (what you sell, your ICP, its pains, qualifiers/disqualifiers). Inside it you create **ICPs** — Trigify listening searches. Kairos pulls the posts those searches collect, enriches each author's LinkedIn profile, and has Claude judge every post against the offer. The best leads land in the **Inbox** (recommended, last 3 days) and **All leads** (all-time).

## Stack

- **Frontend:** vanilla JS ES modules, served static from `app/`.
- **Backend:** a single Node HTTP server (`server.mjs`) — static file server + Trigify proxy + JSON data stores + the `/analyze` endpoint that runs Claude.
- **AI:** Anthropic SDK (`@anthropic-ai/sdk`), Claude runs **server-side only** — the key never reaches the browser.
- **Data:** flat JSON files in `data/` (`offers.json`, `leads.json`, `profiles.json`).

## Environment variables

| Var | Required | Notes |
|-----|----------|-------|
| `TRIGIFY_API_KEY` | yes | Trigify `x-api-key`. |
| `ANTHROPIC_API_KEY` | yes | Enables lead analysis. Without it the app runs but can't qualify. |
| `PORT` | no | Provided automatically by the host. Defaults to `4173` locally. |

## Run locally

```bash
npm install
cp .env.example .env      # then fill in your keys
node --env-file=.env server.mjs
# → http://localhost:4173
```

`npm start` also works if the keys are already in your environment.

## Deploy on Railway

1. Create a new Railway project **from this GitHub repo**.
2. In the service's **Variables**, add `TRIGIFY_API_KEY` and `ANTHROPIC_API_KEY`.
3. Railway auto-detects Node, runs `npm install`, then `npm start`. It injects `PORT`; the server binds `0.0.0.0` automatically when `PORT` is set.
4. Open the generated public URL.

No Railway cron or extra config is needed — the server runs continuously.

## Data & privacy

`data/leads.json` and `data/profiles.json` hold collected posts and enriched LinkedIn profiles of real people, so they are **git-ignored** and never committed. They regenerate at runtime. Only `data/offers.json` (your own offer config) is tracked.
