# PAL CaféBot

PAL Café customer AI ordering and service bot — Khalifa City, Abu Dhabi, UAE.

## Status

Steps 1–31 of the build sequence are complete: menu browsing, ordering (add/modify/remove),
bilingual (English/Arabic) support, recommendations, promotions, pickup and delivery with
address confirmation, deterministic pricing, final order review, confirmation gate, order
persistence, and a staff/bar dashboard.

## Architecture

- **Frontend** (`frontend/`) — Static customer chat UI (`index.html`) and staff dashboard
  (`dashboard.html`). No business logic; only displays state returned by the backend.
- **Backend** (`backend/`) — Express API server. Owns order state, menu/promotion validation,
  deterministic price calculation, and order persistence. The backend — not the AI — is the
  source of truth for prices and totals.
- **AI (Anthropic API)** — Used only for conversation and understanding customer intent. Never
  used to calculate final prices or invent menu/promotion data.
- **Data** (`data/`) — `menu.json` and `promotions.json` (source of truth, edited by staff, not
  the AI); `orders.json` (confirmed orders, written by the backend).
- **Prompt** (`prompts/system-prompt.md`) — PAL CaféBot's conversation rules and boundaries.

## Setup

1. Install dependencies:
   ```
   npm install
   ```
2. Copy `.env.example` to `.env` and fill in real values:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ANTHROPIC_MODEL=claude-sonnet-5
   PORT=3000
   FRONTEND_ORIGIN=http://localhost:5500
   ```
   `.env` is gitignored — never commit it.

## Running locally

**Backend:**
```
npm start
```
Starts the API server on `PORT` (default 3000): `POST /api/chat`, `GET /api/orders`,
`PATCH /api/orders/:orderId/status`.

**Frontend:**
Serve the `frontend/` folder with any static file server (no build step — plain HTML/CSS/JS)
and open it in a browser:
- `index.html` — customer chat
- `dashboard.html` — staff/bar dashboard (no authentication — see Deployment notes below)

There's no bundler or build script because there's nothing to bundle: no framework, no
transpilation, no dependencies beyond what's already loaded via `<script>` tags.

## Deployment

1. **Backend**: deploy `backend/` (plus `data/`, `prompts/`, `package.json`) to any Node
   hosting platform. Set `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `PORT`, and `FRONTEND_ORIGIN`
   (the deployed frontend's real origin, for CORS) as environment variables — never in code.
2. **Frontend**: deploy `frontend/` to any static host. Update the `API_URL` constant in
   `script.js` and the `API_BASE` constant in `dashboard.js` to the backend's real URL.
3. **Orders storage**: `data/orders.json` is a plain file on the backend's filesystem. On most
   hosting platforms this is ephemeral (wiped on redeploy) unless the host provides persistent
   disk storage — check your platform's docs before relying on it for real orders.
4. **Dashboard access**: `dashboard.html` has no login. Do not deploy it anywhere publicly
   reachable without restricting access first (e.g. hosting-level IP allowlist, a reverse proxy
   with auth, or a private network) — it displays customer names, phone numbers, and addresses.
5. **Secrets**: confirm `.env` was never committed (`git log --all --full-history -- .env`
   should return nothing) and that the platform's own secret manager is used for
   `ANTHROPIC_API_KEY` in production.

## Folder Structure

- `prompts/` — AI system prompt
- `data/` — menu, promotions, and orders data (JSON)
- `frontend/` — customer chat UI and staff dashboard
- `backend/` — API server and order logic
- `.env.example` — placeholder environment variables (no real secrets)
