const crypto = require("crypto");

// In-memory session store. No database — orders live only for the process lifetime,
// per project rule "Do not add a database unless explicitly instructed."
const sessions = new Map();

function createOrderState() {
  return {
    items: [], // { itemId, name, quantity, size, options: [], unitPrice }
    order_type: null, // "pickup" | "delivery"
    customer_details: {}, // name, phone, address, unit, instructions, pickupTime
    promotion: null, // promotion id applied, or null
    subtotal: 0,
    tax: 0,
    delivery_fee: 0,
    total: 0,
    confirmation: false,
    status: "draft", // "draft" | "confirmed"
  };
}

function getOrCreateSession(sessionId) {
  if (sessionId && sessions.has(sessionId)) {
    return { sessionId, order: sessions.get(sessionId) };
  }
  const id = sessionId && typeof sessionId === "string" ? sessionId : crypto.randomUUID();
  const order = createOrderState();
  sessions.set(id, order);
  return { sessionId: id, order };
}

function findMenuItem(menu, itemId) {
  return menu.find((item) => item.id === itemId) || null;
}

// Adds one line item to the order after validating it against the menu.
// Returns { ok: true } on success or { ok: false, error } with a customer-facing message.
function addItemToOrder(order, menu, { itemId, quantity, size, options }) {
  const menuItem = findMenuItem(menu, itemId);
  if (!menuItem) {
    return { ok: false, error: `Item "${itemId}" was not found in the current PAL Café menu.` };
  }

  if (!menuItem.availability) {
    return { ok: false, error: `${menuItem.name} is not currently available.` };
  }

  if (!Number.isInteger(quantity) || quantity < 1) {
    return { ok: false, error: "Quantity must be a whole number of 1 or more." };
  }

  const menuSizes = Array.isArray(menuItem.sizes) ? menuItem.sizes : [];
  if (size !== undefined && size !== null && size !== "") {
    if (!menuSizes.includes(size)) {
      return { ok: false, error: `${menuItem.name} does not have a size option called "${size}".` };
    }
  } else if (menuSizes.length > 0) {
    return { ok: false, error: `Please choose a size for ${menuItem.name}: ${menuSizes.join(", ")}.` };
  }

  const menuOptions = Array.isArray(menuItem.options) ? menuItem.options : [];
  const selectedOptions = Array.isArray(options) ? options : [];
  for (const opt of selectedOptions) {
    if (!menuOptions.includes(opt)) {
      return { ok: false, error: `${menuItem.name} does not have an option called "${opt}".` };
    }
  }

  const newItem = {
    lineId: crypto.randomUUID(),
    itemId: menuItem.id,
    name: menuItem.name,
    quantity,
    size: size || null,
    options: selectedOptions,
    unitPrice: menuItem.price_aed,
  };
  order.items.push(newItem);

  return { ok: true, item: newItem };
}

// Modifies quantity, size, and/or options of an existing order line.
// Only fields provided (not undefined) are changed; each provided field is validated against the menu.
// Returns { ok: true } on success or { ok: false, error } with a customer-facing message.
function modifyOrderItem(order, menu, { lineId, quantity, size, options }) {
  const orderItem = order.items.find((item) => item.lineId === lineId);
  if (!orderItem) {
    return { ok: false, error: "That item was not found in the current order." };
  }

  const menuItem = findMenuItem(menu, orderItem.itemId);
  if (!menuItem) {
    return { ok: false, error: `Item "${orderItem.itemId}" was not found in the current PAL Café menu.` };
  }

  if (quantity !== undefined) {
    if (!Number.isInteger(quantity) || quantity < 1) {
      return { ok: false, error: "Quantity must be a whole number of 1 or more." };
    }
  }

  const menuSizes = Array.isArray(menuItem.sizes) ? menuItem.sizes : [];
  if (size !== undefined) {
    if (size !== null && size !== "" && !menuSizes.includes(size)) {
      return { ok: false, error: `${menuItem.name} does not have a size option called "${size}".` };
    }
    if ((size === null || size === "") && menuSizes.length > 0) {
      return { ok: false, error: `Please choose a size for ${menuItem.name}: ${menuSizes.join(", ")}.` };
    }
  }

  const menuOptions = Array.isArray(menuItem.options) ? menuItem.options : [];
  if (options !== undefined) {
    const selectedOptions = Array.isArray(options) ? options : [];
    for (const opt of selectedOptions) {
      if (!menuOptions.includes(opt)) {
        return { ok: false, error: `${menuItem.name} does not have an option called "${opt}".` };
      }
    }
  }

  if (quantity !== undefined) orderItem.quantity = quantity;
  if (size !== undefined) orderItem.size = size || null;
  if (options !== undefined) orderItem.options = Array.isArray(options) ? options : [];

  return { ok: true, item: orderItem };
}

// Removes one line item from the order entirely.
// Returns { ok: true } on success or { ok: false, error } with a customer-facing message.
function removeOrderItem(order, { lineId }) {
  const index = order.items.findIndex((item) => item.lineId === lineId);
  if (index === -1) {
    return { ok: false, error: "That item was not found in the current order." };
  }

  const [removedItem] = order.items.splice(index, 1);
  return { ok: true, item: removedItem };
}

module.exports = { createOrderState, getOrCreateSession, addItemToOrder, modifyOrderItem, removeOrderItem, sessions };
