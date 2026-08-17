require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const {
  getOrCreateSession,
  addItemToOrder,
  modifyOrderItem,
  removeOrderItem,
  applyPromotion,
  removePromotion,
  setPickupDetails,
  setDeliveryDetails,
  calculateTotals,
  confirmOrder,
  createOrderState,
  ORDER_STATUSES,
  sessions,
} = require("./orderState");

const app = express();
app.set("trust proxy", true); // needed so req.ip reflects the real client IP behind Railway's proxy
app.use(express.json());

const ALLOWED_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5500";
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const PORT = process.env.PORT || 3000;
const MAX_MESSAGE_LENGTH = 2000;

// Serves the customer chat UI and staff dashboard as static files from the same origin as the
// API. Optional: local development can still run the frontend from a separate static server
// (see frontend/script.js and frontend/dashboard.js), which is why this isn't required for dev.
app.use(express.static(path.join(__dirname, "..", "frontend")));

// Simple per-IP rate limit on /api/chat, since each message triggers a real (billed) AI call.
// In-memory only — resets on restart, fine for a single-instance demo deployment.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 10;
const rateLimitState = new Map(); // ip -> { count, windowStart }

function chatRateLimiter(req, res, next) {
  const ip = req.ip || "unknown";
  const now = Date.now();
  const entry = rateLimitState.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitState.set(ip, { count: 1, windowStart: now });
    return next();
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterSeconds = Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000);
    res.setHeader("Retry-After", String(retryAfterSeconds));
    return res.status(429).json({ error: "Too many messages — please wait a moment before sending another." });
  }

  entry.count += 1;
  next();
}

const SYSTEM_PROMPT_PATH = path.join(__dirname, "..", "prompts", "system-prompt.md");
const SYSTEM_PROMPT = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf-8");

const MENU_PATH = path.join(__dirname, "..", "data", "menu.json");
const MENU = JSON.parse(fs.readFileSync(MENU_PATH, "utf-8"));

function buildMenuContext(menu) {
  const header =
    "## Current PAL Café Menu (source of truth — JSON)\n" +
    "This is the ONLY valid menu data. Never state a product, price, option, or availability that is not present here. " +
    'If a customer asks about an item that is not in this list, respond: "I don\'t have that item in the current PAL Café menu."\n\n';
  return header + JSON.stringify(menu, null, 2);
}

const MENU_CONTEXT = buildMenuContext(MENU);

const PROMOTIONS_PATH = path.join(__dirname, "..", "data", "promotions.json");
const PROMOTIONS = JSON.parse(fs.readFileSync(PROMOTIONS_PATH, "utf-8"));
const ACTIVE_PROMOTIONS = PROMOTIONS.filter((p) => p.active);

function buildPromotionsContext(activePromotions) {
  if (activePromotions.length === 0) {
    return "## Active Promotions\nThere are no active promotions right now.";
  }
  const header =
    "## Active Promotions (source of truth — JSON)\n" +
    "These are the ONLY promotions that currently exist and may be mentioned or applied. Inactive/expired promotions are not shown to you and must never be mentioned or invented. " +
    "For each promotion, read its 'eligibility' text and ask the customer whatever is needed to judge it honestly — do not assume they qualify.\n\n";
  return header + JSON.stringify(activePromotions, null, 2);
}

const PROMOTIONS_CONTEXT = buildPromotionsContext(ACTIVE_PROMOTIONS);

const ORDERS_PATH = path.join(__dirname, "..", "data", "orders.json");

// Appends one confirmed order to data/orders.json. Simple file-based storage — no database,
// per project rules. Re-reads the file each time so concurrent server restarts don't lose data.
function saveConfirmedOrder(confirmedOrder) {
  const existing = JSON.parse(fs.readFileSync(ORDERS_PATH, "utf-8"));
  existing.push(confirmedOrder);
  fs.writeFileSync(ORDERS_PATH, JSON.stringify(existing, null, 2) + "\n", "utf-8");
}

const SYSTEM_WITH_MENU = `${SYSTEM_PROMPT}\n\n${MENU_CONTEXT}\n\n${PROMOTIONS_CONTEXT}`;

const ARABIC_SCRIPT_PATTERN = /[؀-ۿ]/;

function detectLanguage(message) {
  return ARABIC_SCRIPT_PATTERN.test(message) ? "Arabic" : "English";
}

// Deterministic second gate on top of the AI's own judgment before an order can be finalized.
// Checked against the customer's actual raw message for this turn — never against anything the
// AI reports — so a hallucinated or premature confirm_order call can't persist an order without
// the real customer text actually looking like a clear yes. This does not replace the prompt's
// confirmation rules; it's a backstop, since "never save an unconfirmed order" is a hard project rule.
const AMBIGUOUS_CONFIRMATION_PATTERN = /^(okay|ok|fine|sounds good|thanks|thank you|maybe|تمام|طيب|شكرا)[.!\s]*$/i;
const CLEAR_CONFIRMATION_PATTERN =
  /\b(yes|confirm|i confirm|that'?s correct|place the order)\b|نعم|أكد|أؤكد|تأكيد الطلب|قدم الطلب/i;

function looksLikeExplicitConfirmation(message) {
  if (typeof message !== "string") return false;
  const trimmed = message.trim();
  if (AMBIGUOUS_CONFIRMATION_PATTERN.test(trimmed)) return false;
  return CLEAR_CONFIRMATION_PATTERN.test(trimmed);
}

function buildLanguageContext(language) {
  return `## Language Reminder (this turn)\nThe customer's latest message is written in ${language}. Reply in ${language}, regardless of what language earlier turns used.`;
}

function buildOrderContext(order) {
  const promotionLine = order.promotion
    ? `\n\nApplied promotion: ${order.promotion}`
    : "\n\nApplied promotion: none";

  const fulfillmentLine =
    `\n\nOrder type: ${order.order_type || "not chosen yet"}\n` +
    `Customer details collected so far: ${JSON.stringify(order.customer_details)}`;

  const totalsLine =
    "\n\nTotals (calculated by the application — read these exact values if asked, never calculate your own):\n" +
    `Subtotal: ${order.subtotal} AED\n` +
    `Discount: ${order.discount} AED\n` +
    `Tax: ${order.tax} AED\n` +
    `Delivery fee: ${order.delivery_fee} AED\n` +
    `Total: ${order.total} AED`;

  if (order.items.length === 0) {
    return `## Current Order\nThe order is currently empty.${promotionLine}${fulfillmentLine}${totalsLine}`;
  }
  const header =
    "## Current Order (source of truth — JSON)\n" +
    "This is the customer's order so far. Use each item's 'lineId' to target it when modifying or removing an item.\n\n";
  return header + JSON.stringify(order.items, null, 2) + promotionLine + fulfillmentLine + totalsLine;
}

const MAX_TOOL_ROUNDS = 4;

const TOOLS = [
  {
    name: "add_item_to_order",
    description:
      "Add one product from the PAL Café menu to the customer's current order. Only call this after the customer has clearly chosen a specific menu item and quantity (and a size, if that item has sizes).",
    input_schema: {
      type: "object",
      properties: {
        itemId: {
          type: "string",
          description: "The exact 'id' field of the menu item, taken from the menu JSON.",
        },
        quantity: {
          type: "integer",
          minimum: 1,
          description: "Number of units of this item to add.",
        },
        size: {
          type: "string",
          description: "The selected size, only if the menu item has a non-empty 'sizes' list.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Selected customizations, only from the menu item's 'options' list.",
        },
      },
      required: ["itemId", "quantity"],
    },
  },
  {
    name: "modify_order_item",
    description:
      "Change the quantity, size, or customizations of an item already in the customer's current order. Only include the fields that are actually changing.",
    input_schema: {
      type: "object",
      properties: {
        lineId: {
          type: "string",
          description: "The exact 'lineId' of the order item to modify, taken from the current order JSON.",
        },
        quantity: {
          type: "integer",
          minimum: 1,
          description: "New quantity, only if the customer is changing the quantity.",
        },
        size: {
          type: "string",
          description: "New size, only if the customer is changing the size.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "New full list of customizations, only if the customer is changing them.",
        },
      },
      required: ["lineId"],
    },
  },
  {
    name: "remove_order_item",
    description: "Remove an item entirely from the customer's current order.",
    input_schema: {
      type: "object",
      properties: {
        lineId: {
          type: "string",
          description: "The exact 'lineId' of the order item to remove, taken from the current order JSON.",
        },
      },
      required: ["lineId"],
    },
  },
  {
    name: "apply_promotion",
    description:
      "Apply an active promotion to the customer's order, after you've confirmed with the customer that they meet its eligibility criteria.",
    input_schema: {
      type: "object",
      properties: {
        promoId: {
          type: "string",
          description: "The exact 'id' field of the promotion, taken from the Active Promotions list.",
        },
      },
      required: ["promoId"],
    },
  },
  {
    name: "remove_promotion",
    description: "Remove any promotion currently applied to the order.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "set_pickup_details",
    description:
      "Set the order to pickup and record the customer's name and, optionally, a pickup time. Only call this with information the customer actually gave you — never guess a name or time.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The customer's name, exactly as they gave it.",
        },
        pickupTime: {
          type: "string",
          description: "Optional pickup time, exactly as the customer stated it (e.g. '5:30 PM', 'in 20 minutes').",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "set_delivery_details",
    description:
      "Set the order to delivery and record the customer's delivery details. Only call this with information the customer actually gave you — never guess a name, phone, or address.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The customer's name, exactly as they gave it." },
        phone: { type: "string", description: "The customer's phone number, exactly as they gave it." },
        address: { type: "string", description: "The full delivery address, exactly as they gave it." },
        unit: { type: "string", description: "Apartment/unit number, only if the customer mentioned one." },
        instructions: { type: "string", description: "Delivery instructions, only if the customer gave any." },
      },
      required: ["name", "phone", "address"],
    },
  },
  {
    name: "confirm_order",
    description:
      "Finalize and save the order. Only call this after the customer has explicitly confirmed (a clear 'yes'/'confirm'/'place the order' — not an ambiguous 'okay' or 'sounds good') in response to seeing the Final Order Review, including the address confirmation for delivery orders if applicable.",
    input_schema: { type: "object", properties: {} },
  },
];

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

app.post("/api/chat", chatRateLimiter, async (req, res) => {
  const { message, conversationHistory, sessionId } = req.body || {};

  if (typeof message !== "string" || message.trim().length === 0) {
    return res.status(400).json({ error: "message is required and must be a non-empty string" });
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `message must be ${MAX_MESSAGE_LENGTH} characters or fewer` });
  }

  if (conversationHistory !== undefined && !Array.isArray(conversationHistory)) {
    return res.status(400).json({ error: "conversationHistory must be an array if provided" });
  }

  if (sessionId !== undefined && typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId must be a string if provided" });
  }

  const { sessionId: activeSessionId, order } = getOrCreateSession(sessionId);

  if (!anthropic || !process.env.ANTHROPIC_MODEL) {
    console.error("AI service not configured: missing ANTHROPIC_API_KEY or ANTHROPIC_MODEL");
    return res.status(500).json({ error: "AI service is not configured" });
  }

  const language = detectLanguage(message);
  const messages = [
    ...(conversationHistory || []),
    { role: "user", content: `${message}\n\n[Reply in ${language}.]` },
  ];
  const languageContext = buildLanguageContext(language);

  try {
    let completion;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const systemPrompt = `${SYSTEM_WITH_MENU}\n\n${buildOrderContext(order)}\n\n${languageContext}`;
      completion = await anthropic.messages.create({
        model: process.env.ANTHROPIC_MODEL,
        max_tokens: 2048,
        system: systemPrompt,
        tools: TOOLS,
        thinking: { type: "disabled" },
        messages,
      });

      if (completion.stop_reason !== "tool_use") break;

      messages.push({ role: "assistant", content: completion.content });

      const toolResults = [];
      for (const block of completion.content) {
        if (block.type !== "tool_use") continue;

        if (block.name === "add_item_to_order") {
          const result = addItemToOrder(order, MENU, block.input || {});
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result.ok
              ? `Added successfully. This is a BRAND NEW line that did not exist before this call: ${JSON.stringify(result.item)}. When telling the customer, say it was just added ("I've added...", "You now have...") — do NOT say "already had", "already at", or "no change needed", since this item was not in the order before this tool call.`
              : result.error,
            is_error: !result.ok,
          });
        } else if (block.name === "modify_order_item") {
          const result = modifyOrderItem(order, MENU, block.input || {});
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result.ok
              ? `Updated. This line now reads exactly: ${JSON.stringify(result.item)}. Use these exact values (especially quantity) when you tell the customer what happened — do not add or assume any quantity beyond this.`
              : result.error,
            is_error: !result.ok,
          });
        } else if (block.name === "remove_order_item") {
          const result = removeOrderItem(order, block.input || {});
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result.ok
              ? `Removed. This line is gone: ${JSON.stringify(result.item)}. Do not refer to it as still being in the order.`
              : result.error,
            is_error: !result.ok,
          });
        } else if (block.name === "apply_promotion") {
          const result = applyPromotion(order, PROMOTIONS, block.input || {});
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result.ok
              ? `Applied. Promotion now on the order: ${JSON.stringify(result.promotion)}. The discount amount will be reflected in the order totals shown to you next turn.`
              : result.error,
            is_error: !result.ok,
          });
        } else if (block.name === "remove_promotion") {
          removePromotion(order);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: "Promotion removed from the order.",
            is_error: false,
          });
        } else if (block.name === "set_pickup_details") {
          const result = setPickupDetails(order, block.input || {});
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result.ok
              ? `Pickup set. Customer details now: ${JSON.stringify(result.customer_details)}.`
              : result.error,
            is_error: !result.ok,
          });
        } else if (block.name === "set_delivery_details") {
          const result = setDeliveryDetails(order, block.input || {});
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result.ok
              ? `Delivery set. Customer details now: ${JSON.stringify(result.customer_details)}.`
              : result.error,
            is_error: !result.ok,
          });
        } else if (block.name === "confirm_order") {
          let result;
          if (!looksLikeExplicitConfirmation(message)) {
            result = {
              ok: false,
              error:
                "The customer's message this turn doesn't read as an explicit confirmation. Do not treat this as confirmed — ask the customer directly: 'Would you like me to confirm and place this order?' and wait for a clear yes.",
            };
          } else {
            result = confirmOrder(order, PROMOTIONS);
            if (result.ok) {
              saveConfirmedOrder(result.confirmedOrder);
              sessions.set(activeSessionId, createOrderState());
            }
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result.ok
              ? `Order confirmed and saved. Order ID: ${result.confirmedOrder.orderId}. Give this ID to the customer. A fresh empty order has started for anything further.`
              : result.error,
            is_error: !result.ok,
          });
        } else {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Unknown tool: ${block.name}`,
            is_error: true,
          });
        }
      }

      calculateTotals(order, PROMOTIONS);

      messages.push({ role: "user", content: toolResults });
    }

    const reply = completion.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    res.json({ reply, sessionId: activeSessionId, order });
  } catch (err) {
    console.error("AI request failed:", err.message);
    res.status(502).json({ error: "Failed to reach the AI service. Please try again." });
  }
});

// Staff/bar dashboard — read confirmed orders and update their status.
// No customer-facing AI involved; reads/writes data/orders.json directly.

app.get("/api/orders", (req, res) => {
  const orders = JSON.parse(fs.readFileSync(ORDERS_PATH, "utf-8"));
  res.json({ orders });
});

app.patch("/api/orders/:orderId/status", (req, res) => {
  const { orderId } = req.params;
  const { status } = req.body || {};

  if (typeof status !== "string" || !ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${ORDER_STATUSES.join(", ")}` });
  }

  const orders = JSON.parse(fs.readFileSync(ORDERS_PATH, "utf-8"));
  const order = orders.find((o) => o.orderId === orderId);
  if (!order) {
    return res.status(404).json({ error: "Order not found." });
  }

  order.status = status;
  fs.writeFileSync(ORDERS_PATH, JSON.stringify(orders, null, 2) + "\n", "utf-8");
  res.json({ order });
});

app.listen(PORT, () => {
  console.log(`PAL CaféBot backend listening on port ${PORT}`);
});
