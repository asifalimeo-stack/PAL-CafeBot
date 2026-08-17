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
    discount: 0,
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

// Applies an active promotion to the order by id. Only the 'active' flag is checked here —
// rule-specific eligibility (e.g. "first order", subtotal thresholds) is judged in conversation
// by the AI, since it depends on facts the app can't verify yet (no customer history, no
// deterministic totals until Step 25).
// Returns { ok: true } on success or { ok: false, error } with a customer-facing message.
function applyPromotion(order, promotions, { promoId }) {
  const promotion = promotions.find((p) => p.id === promoId);
  if (!promotion) {
    return { ok: false, error: `Promotion "${promoId}" was not found.` };
  }
  if (!promotion.active) {
    return { ok: false, error: `"${promotion.name}" is not currently active and cannot be applied.` };
  }

  order.promotion = promotion.id;
  return { ok: true, promotion };
}

// Removes any promotion currently applied to the order.
function removePromotion(order) {
  order.promotion = null;
  return { ok: true };
}

// Sets the order to pickup and records the customer's name (required) and an optional pickup time.
// Never guesses either value — both must be explicitly provided by the caller.
// Returns { ok: true } on success or { ok: false, error } with a customer-facing message.
function setPickupDetails(order, { name, pickupTime }) {
  if (typeof name !== "string" || name.trim().length === 0) {
    return { ok: false, error: "A customer name is required for pickup orders." };
  }

  order.order_type = "pickup";
  order.customer_details.name = name.trim();

  if (pickupTime !== undefined) {
    if (pickupTime === null || pickupTime === "") {
      delete order.customer_details.pickupTime;
    } else if (typeof pickupTime === "string") {
      order.customer_details.pickupTime = pickupTime.trim();
    } else {
      return { ok: false, error: "Pickup time must be text (e.g. '5:30 PM' or 'in 20 minutes')." };
    }
  }

  return { ok: true, customer_details: order.customer_details };
}

// Sets the order to delivery and records the required delivery details.
// name, phone, and address are required; unit and instructions are optional.
// Never guesses any value — all must be explicitly provided by the caller.
// Returns { ok: true } on success or { ok: false, error } with a customer-facing message.
function setDeliveryDetails(order, { name, phone, address, unit, instructions }) {
  if (typeof name !== "string" || name.trim().length === 0) {
    return { ok: false, error: "A customer name is required for delivery orders." };
  }
  if (typeof phone !== "string" || phone.trim().length === 0) {
    return { ok: false, error: "A phone number is required for delivery orders." };
  }
  if (typeof address !== "string" || address.trim().length === 0) {
    return { ok: false, error: "A full delivery address is required for delivery orders." };
  }

  order.order_type = "delivery";
  order.customer_details.name = name.trim();
  order.customer_details.phone = phone.trim();
  order.customer_details.address = address.trim();

  if (unit !== undefined) {
    if (unit === null || unit === "") {
      delete order.customer_details.unit;
    } else if (typeof unit === "string") {
      order.customer_details.unit = unit.trim();
    } else {
      return { ok: false, error: "Apartment/unit must be text." };
    }
  }

  if (instructions !== undefined) {
    if (instructions === null || instructions === "") {
      delete order.customer_details.instructions;
    } else if (typeof instructions === "string") {
      order.customer_details.instructions = instructions.trim();
    } else {
      return { ok: false, error: "Delivery instructions must be text." };
    }
  }

  return { ok: true, customer_details: order.customer_details };
}

// Delivery fee — simple flat placeholder fee pending PAL Café's actual delivery pricing policy.
const DELIVERY_FEE_AED = 10;

// Tax rate — the PAL Café menu PDF states prices are inclusive of applicable taxes, so no
// additional tax is added on top of menu prices. Kept as a rate (not hardcoded 0 inline) so it
// stays simple to change in one place if that policy is ever confirmed otherwise.
const TAX_RATE = 0;

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Recalculates subtotal, discount, tax, delivery fee, and total from the order's current items,
// order_type, and applied promotion. This is the ONLY place order totals are computed — the AI
// never calculates them. Call this after any mutation that could affect price (item add/modify/
// remove, promotion apply/remove, order_type change).
function calculateTotals(order, promotions) {
  const subtotal = order.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  // Note: menu item 'options' currently carry no price delta in data/menu.json, so options are
  // not added to the subtotal separately here. If priced options are added to the menu later,
  // this calculation must be updated to include them.

  let deliveryFee = order.order_type === "delivery" ? DELIVERY_FEE_AED : 0;
  let discount = 0;

  if (order.promotion) {
    const promo = promotions.find((p) => p.id === order.promotion && p.active);
    if (promo) {
      if (promo.id === "promo-sample-welcome10") {
        discount = round2(subtotal * 0.1);
      } else if (promo.id === "promo-sample-delivery-waiver") {
        if (order.order_type === "delivery" && subtotal >= 100) {
          deliveryFee = 0;
        }
      }
      // promo-sample-freefries is not handled here: its benefit is a free menu item, not a
      // price adjustment, and there's no mechanism yet to auto-add a free item to the order.
      // It's also inactive by default, so this doesn't affect current behavior.
    }
  }

  const tax = round2(subtotal * TAX_RATE);
  const total = round2(subtotal - discount + tax + deliveryFee);

  order.subtotal = round2(subtotal);
  order.discount = discount;
  order.tax = tax;
  order.delivery_fee = deliveryFee;
  order.total = total;

  return order;
}

// The only valid statuses a confirmed, persisted order can have. Shared by confirmOrder() and
// the staff dashboard's status-update endpoint so there's one source of truth for valid values.
const ORDER_STATUSES = ["Confirmed", "Preparing", "Ready", "Out for Delivery", "Completed", "Cancelled"];

// Validates the order is actually complete enough to confirm, recalculates totals one final
// time, and returns a persistable snapshot. Does NOT write to disk or touch session state —
// callers (server.js) are responsible for persisting the snapshot and starting a fresh order.
// This is the hard gate: an incomplete order can never be confirmed, no matter what the AI asks for.
// Returns { ok: true, confirmedOrder } or { ok: false, error }.
function confirmOrder(order, promotions) {
  if (!Array.isArray(order.items) || order.items.length === 0) {
    return { ok: false, error: "Cannot confirm an empty order — add at least one item first." };
  }
  if (order.order_type !== "pickup" && order.order_type !== "delivery") {
    return { ok: false, error: "Order type (pickup or delivery) must be set before confirming." };
  }
  if (!order.customer_details.name) {
    return { ok: false, error: "Customer name is required before confirming." };
  }
  if (order.order_type === "delivery" && (!order.customer_details.phone || !order.customer_details.address)) {
    return { ok: false, error: "Phone and full delivery address are required before confirming a delivery order." };
  }

  calculateTotals(order, promotions);

  const confirmedOrder = {
    orderId: crypto.randomUUID().slice(0, 8).toUpperCase(),
    timestamp: new Date().toISOString(),
    status: "Confirmed",
    items: order.items,
    order_type: order.order_type,
    customer_details: order.customer_details,
    promotion: order.promotion,
    subtotal: order.subtotal,
    discount: order.discount,
    tax: order.tax,
    delivery_fee: order.delivery_fee,
    total: order.total,
  };

  order.confirmation = true;
  order.status = "confirmed";

  return { ok: true, confirmedOrder };
}

module.exports = {
  createOrderState,
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
  ORDER_STATUSES,
  sessions,
};
