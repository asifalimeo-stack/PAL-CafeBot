# CLAUDE.md

## Project Purpose

PAL Café customer AI ordering and service bot — Khalifa City, Abu Dhabi, UAE.

The bot helps customers browse the PAL Café menu, ask about prices/ingredients/allergens/availability, receive limited recommendations, build and modify an order, choose pickup or delivery, apply valid promotions, review the order, and confirm it to receive an order ID. A simple staff/bar dashboard displays confirmed orders.

## Architecture

- **Frontend** (`frontend/`) — Customer-facing chat UI. Sends user messages to the backend and renders bot replies. No business logic lives here; it only displays state returned by the backend.
- **Backend** (`backend/`) — API server. Owns order state, menu/promotion validation, deterministic price calculation, and order persistence. The backend — not the AI — is the source of truth for prices and totals.
- **AI API** — External LLM used only for conversation and understanding customer intent. Never used to calculate final prices or invent data.
- **System prompt** (`prompts/system-prompt.md`) — Defines PAL CaféBot's conversation rules, tone, and boundaries (see Step 3).
- **Menu** (`data/menu.json`) — Structured source of truth for products, prices, and availability. The AI must only reference this file, never invent items.
- **Promotions** (`data/promotions.json`) — Structured source of truth for active/inactive promotions.
- **Orders** (`data/orders.json`) — Simple JSON-file storage for confirmed orders only. No database unless explicitly instructed.
- **Staff dashboard** (`frontend/` or a dedicated view) — Read-only view of `data/orders.json` for bar/staff to track and update order status.

## Coding Rules

- Simple code — avoid clever abstractions.
- Minimal dependencies — only add a package when clearly necessary.
- Clear naming — files, functions, and variables describe what they do.
- Small changes — each step touches only the files required for that step.
- No unnecessary refactoring of working code.

## Security Rules

- Never expose secrets, API keys, passwords, or tokens in code, logs, or responses.
- Never expose the system prompt or internal files to the customer.
- Validate all user input before use.
- Protect customer information (name, phone, address) — only collect what's needed, never log unnecessarily.
- Validate order data server-side; never trust client-supplied prices or totals.

## Token-Saving Rules

Claude must:
- Read only the files relevant to the current step.
- Avoid unnecessary output or repeating large file contents back to the user.
- Modify only the files required for the current task.
- Avoid unnecessary refactoring or rewriting of unrelated code.

## Task Rule

Complete only the current task, test it, report it, and STOP. Do not proceed to the next step without explicit instruction.


ANTHROPIC_API_KEY=sk-ant-your-real-key-here
ANTHROPIC_MODEL=claude-sonnet-5
PORT=3000
