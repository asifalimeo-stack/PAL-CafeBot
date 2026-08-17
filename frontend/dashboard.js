// PAL Café — Bar/Staff Dashboard. Reads and updates data/orders.json via the backend API.

// This dashboard has no authentication — restrict access at the network/hosting level
// before deploying it anywhere reachable by the public.
// Same relative/absolute API URL logic as script.js — see there for why.
const API_BASE = window.location.port === "5500" ? "http://localhost:3000" : "";
const STATUSES = ["Confirmed", "Preparing", "Ready", "Out for Delivery", "Completed", "Cancelled"];

const ordersList = document.getElementById("ordersList");
const emptyState = document.getElementById("emptyState");
const dashboardError = document.getElementById("dashboardError");
const orderCount = document.getElementById("orderCount");
const refreshBtn = document.getElementById("refreshBtn");

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function statusClass(status) {
  return "status-" + status.toLowerCase().replace(/\s+/g, "-");
}

function formatTimestamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function itemLine(item) {
  const parts = [];
  if (item.size) parts.push(item.size);
  if (Array.isArray(item.options) && item.options.length) parts.push(item.options.join(", "));
  const detail = parts.length ? ` — ${escapeHtml(parts.join(", "))}` : "";
  return `
    <tr>
      <td class="qty">${item.quantity}×</td>
      <td>${escapeHtml(item.name)}${detail}</td>
      <td class="total">${(item.unitPrice * item.quantity).toFixed(2)} AED</td>
    </tr>`;
}

function customerInfoHtml(order) {
  const d = order.customer_details || {};
  if (order.order_type === "delivery") {
    const addressLine = d.unit ? `${d.address}, ${d.unit}` : d.address;
    return `
      <div><strong>${escapeHtml(d.name || "")}</strong></div>
      <div>${escapeHtml(d.phone || "")}</div>
      <div>${escapeHtml(addressLine || "")}</div>
      ${d.instructions ? `<div>Note: ${escapeHtml(d.instructions)}</div>` : ""}
    `;
  }
  // pickup
  return `
    <div><strong>${escapeHtml(d.name || "")}</strong></div>
    ${d.pickupTime ? `<div>Pickup time: ${escapeHtml(d.pickupTime)}</div>` : `<div>Pickup time: ASAP</div>`}
  `;
}

function orderCardHtml(order) {
  const fulfillment = order.order_type === "delivery" ? "Delivery" : "Pickup";
  const promoLine = order.promotion ? `<div class="order-section"><span class="order-section-label">Promotion</span><div>${escapeHtml(order.promotion)}</div></div>` : "";

  return `
    <article class="order-card" data-order-id="${escapeHtml(order.orderId)}">
      <div class="order-card-head">
        <span class="order-id">#${escapeHtml(order.orderId)}</span>
        <span class="status-badge ${statusClass(order.status)}">${escapeHtml(order.status)}</span>
        <span class="order-timestamp">${formatTimestamp(order.timestamp)}</span>
      </div>

      <div class="order-section">
        <span class="order-section-label">${escapeHtml(fulfillment)}</span>
        ${customerInfoHtml(order)}
      </div>

      <div class="order-section">
        <span class="order-section-label">Items</span>
        <table class="order-items-table">
          <tbody>${order.items.map(itemLine).join("")}</tbody>
        </table>
      </div>

      ${promoLine}

      <div class="order-footer">
        <span class="order-total">Total: ${Number(order.total).toFixed(2)} AED</span>
        <select class="status-select" aria-label="Update status for order ${escapeHtml(order.orderId)}">
          ${STATUSES.map((s) => `<option value="${s}" ${s === order.status ? "selected" : ""}>${s}</option>`).join("")}
        </select>
      </div>
    </article>
  `;
}

async function loadOrders() {
  dashboardError.hidden = true;
  try {
    const res = await fetch(`${API_BASE}/api/orders`);
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    const data = await res.json();
    renderOrders(data.orders || []);
  } catch (err) {
    dashboardError.hidden = false;
  }
}

function renderOrders(orders) {
  const sorted = [...orders].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  orderCount.textContent = `${sorted.length} order${sorted.length === 1 ? "" : "s"}`;

  if (sorted.length === 0) {
    ordersList.innerHTML = "";
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;
  ordersList.innerHTML = sorted.map(orderCardHtml).join("");
}

async function updateStatus(orderId, status) {
  try {
    const res = await fetch(`${API_BASE}/api/orders/${encodeURIComponent(orderId)}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    await loadOrders();
  } catch (err) {
    dashboardError.hidden = false;
  }
}

ordersList.addEventListener("change", (event) => {
  if (!event.target.classList.contains("status-select")) return;
  const card = event.target.closest(".order-card");
  const orderId = card.dataset.orderId;
  updateStatus(orderId, event.target.value);
});

refreshBtn.addEventListener("click", loadOrders);

loadOrders();
