require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const { getOrCreateSession, addItemToOrder, modifyOrderItem, removeOrderItem } = require("./orderState");

const app = express();
app.use(express.json());

const ALLOWED_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5500";
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const PORT = process.env.PORT || 3000;
const MAX_MESSAGE_LENGTH = 2000;

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
const SYSTEM_WITH_MENU = `${SYSTEM_PROMPT}\n\n${MENU_CONTEXT}`;

const ARABIC_SCRIPT_PATTERN = /[؀-ۿ]/;

function detectLanguage(message) {
  return ARABIC_SCRIPT_PATTERN.test(message) ? "Arabic" : "English";
}

function buildLanguageContext(language) {
  return `## Language Reminder (this turn)\nThe customer's latest message is written in ${language}. Reply in ${language}, regardless of what language earlier turns used.`;
}

function buildOrderContext(order) {
  if (order.items.length === 0) {
    return "## Current Order\nThe order is currently empty.";
  }
  const header =
    "## Current Order (source of truth — JSON)\n" +
    "This is the customer's order so far. Use each item's 'lineId' to target it when modifying or removing an item.\n\n";
  return header + JSON.stringify(order.items, null, 2);
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
];

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

app.post("/api/chat", async (req, res) => {
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
        max_tokens: 1024,
        system: systemPrompt,
        tools: TOOLS,
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
              ? `Added. This line now reads exactly: ${JSON.stringify(result.item)}. Use these exact values (especially quantity) when you tell the customer what happened — do not add or assume any quantity beyond this.`
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
        } else {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Unknown tool: ${block.name}`,
            is_error: true,
          });
        }
      }

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

app.listen(PORT, () => {
  console.log(`PAL CaféBot backend listening on port ${PORT}`);
});
