// PAL CaféBot — Chat UI connected to the backend /api/chat endpoint.

// When served by the backend itself (production, or port 3000 locally), use a relative path.
// The local dev workflow serves this page from a separate static server on port 5500, which
// needs the full localhost:3000 URL instead.
const API_URL = window.location.port === "5500" ? "http://localhost:3000/api/chat" : "/api/chat";

const chatArea = document.getElementById("chatArea");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const chatError = document.getElementById("chatError");

let sessionId = null;
let conversationHistory = [];

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Renders a small subset of markdown (bold, bullet lists, line breaks) that the
// bot's replies commonly use. Input is HTML-escaped first, so this cannot inject markup.
function renderBotMarkdown(text) {
  const lines = escapeHtml(text).split("\n");
  const htmlParts = [];
  let listItems = [];

  function flushList() {
    if (listItems.length) {
      htmlParts.push(`<ul>${listItems.join("")}</ul>`);
      listItems = [];
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const bulletMatch = line.match(/^[-*]\s+(.*)$/);
    if (bulletMatch) {
      listItems.push(`<li>${bulletMatch[1]}</li>`);
      continue;
    }
    flushList();
    if (line) htmlParts.push(`<p>${line}</p>`);
  }
  flushList();

  return htmlParts
    .join("")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function addMessage(role, text) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.dir = "auto"; // aligns right-to-left automatically for Arabic text
  if (role === "bot") {
    el.innerHTML = renderBotMarkdown(text);
  } else {
    el.textContent = text;
  }
  chatArea.appendChild(el);
  chatArea.scrollTop = chatArea.scrollHeight;
  return el;
}

function showLoading() {
  const el = document.createElement("div");
  el.className = "msg loading";
  el.innerHTML = `<span class="typing-dots"><span></span><span></span><span></span></span>`;
  chatArea.appendChild(el);
  chatArea.scrollTop = chatArea.scrollHeight;
  return el;
}

function hideError() {
  chatError.hidden = true;
}

function showError() {
  chatError.hidden = false;
}

async function sendToBackend(text) {
  const body = { message: text, conversationHistory };
  if (sessionId) body.sessionId = sessionId;

  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return response.json();
}

async function handleSend(event) {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  hideError();
  addMessage("customer", text);
  chatInput.value = "";
  sendBtn.disabled = true;

  const loadingEl = showLoading();

  try {
    const data = await sendToBackend(text);
    loadingEl.remove();
    addMessage("bot", data.reply);
    conversationHistory.push({ role: "user", content: text });
    conversationHistory.push({ role: "assistant", content: data.reply });
    sessionId = data.sessionId;
  } catch (err) {
    loadingEl.remove();
    showError();
  } finally {
    sendBtn.disabled = false;
    chatInput.focus();
  }
}

chatForm.addEventListener("submit", handleSend);

addMessage("bot", "Hi! Welcome to PAL Café. Ask me about our menu or start an order.");
