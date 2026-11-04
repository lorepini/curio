// Whiteboard view: drag cards, draw connections, see suggested links.
// Uses helpers from app.js: $, api, esc, cardHTML, openCard, state.

const board = { cards: [], connections: [], suggestions: [], scale: 1, tx: 40, ty: 40, shownFor: null };
const CARD_W = 220, GAP_X = 50, ROW_H = 320, COLS = 5;
const viewport = $("#board-viewport");
const world = $("#board-world");

try { $("#show-suggestions").checked = localStorage.getItem("curio.suggest") !== "off"; } catch {}

async function loadBoard() {
  const coll = Number(state.collection || 0);
  const data = await api("/board?collection=" + coll);
  Object.assign(board, data);
  await placeNewCards(coll);

  // While searching, fade out cards that don't match
  let matches = null;
  if (state.query) {
    matches = new Set((await api("/cards?q=" + encodeURIComponent(state.query))).map((c) => c.id));
  }
  renderBoard(matches);

  const name = state.collections.find((c) => c.id == state.collection)?.name || "All cards";
  const n = board.cards.length, k = board.connections.length;
  $("#heading").innerHTML = `${esc(name)}<small>board · ${n} card${n === 1 ? "" : "s"} · ` +
    `${k} connection${k === 1 ? "" : "s"}</small>`;
  $("#empty").hidden = n > 0;

  if (board.shownFor !== coll) {          // first time on this board: show everything
    board.shownFor = coll;
    fitBoard();
  }
}

// Cards that have never been on this board get a spot in a grid below the others
async function placeNewCards(coll) {
  const placed = board.cards.filter((c) => c.x != null);
  const fresh = board.cards.filter((c) => c.x == null);
  if (!fresh.length) return;
  const startY = placed.length ? Math.max(...placed.map((c) => c.y)) + ROW_H : 0;
  fresh.forEach((c, i) => {
    c.x = (i % COLS) * (CARD_W + GAP_X);
    c.y = startY + Math.floor(i / COLS) * ROW_H;
  });
  await savePositions(coll, fresh);
}

function savePositions(coll, cards) {
  return api("/board", {
    method: "PUT",
    body: { collection: coll, positions: cards.map((c) => ({ card_id: c.id, x: Math.round(c.x), y: Math.round(c.y) })) },
  });
}

// ---------- drawing ----------
function renderBoard(matches) {
  $("#board-cards").innerHTML = board.cards.map(cardHTML).join("");
  $("#board-cards").querySelectorAll(".card").forEach((el) => {
    const c = board.cards.find((x) => x.id == el.dataset.id);
    el.classList.add("bcard");
    el.classList.toggle("dim", !!matches && !matches.has(c.id));
    el.style.left = c.x + "px";
    el.style.top = c.y + "px";
    el.insertAdjacentHTML("beforeend", '<span class="handle" title="Drag onto another card to connect">●</span>');
  });
  applyTransform();
  drawLinks();
}

const cardEl = (id) => $(`#board-cards .card[data-id="${id}"]`);

function center(id) {
  const el = cardEl(id);
  return el && { x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop + el.offsetHeight / 2 };
}

function drawLinks(temp) {
  let lines = "", labels = "";
  for (const l of board.connections) {
    const a = center(l.from_id), b = center(l.to_id);
    if (!a || !b) continue;
    lines += `<line class="link" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
    labels += `<button class="link-label ${l.label ? "" : "empty"}" data-link="${l.id}"
      style="left:${(a.x + b.x) / 2}px;top:${(a.y + b.y) / 2}px" title="Edit connection">${esc(l.label) || "✎"}</button>`;
  }
  if ($("#show-suggestions").checked) {
    for (const s of board.suggestions) {
      const a = center(s.from_id), b = center(s.to_id);
      if (!a || !b) continue;
      lines += `<line class="suggest" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
      labels += `<button class="suggest-add" data-a="${s.from_id}" data-b="${s.to_id}"
        style="left:${(a.x + b.x) / 2}px;top:${(a.y + b.y) / 2}px"
        title="Suggested: ${Math.round(s.score * 100)}% similar. Click to connect">+</button>`;
    }
  }
  if (temp) lines += `<line class="link temp" x1="${temp.x1}" y1="${temp.y1}" x2="${temp.x2}" y2="${temp.y2}"/>`;
  $("#board-lines").innerHTML = lines;
  $("#board-labels").innerHTML = labels;
}

// ---------- pan & zoom ----------
function applyTransform() {
  world.style.transform = `translate(${board.tx}px, ${board.ty}px) scale(${board.scale})`;
}

function toWorld(clientX, clientY) {
  const r = viewport.getBoundingClientRect();
  return { x: (clientX - r.left - board.tx) / board.scale, y: (clientY - r.top - board.ty) / board.scale };
}

function zoomAt(factor, clientX, clientY) {
  const r = viewport.getBoundingClientRect();
  const px = clientX - r.left, py = clientY - r.top;
  const next = Math.min(2.5, Math.max(0.15, board.scale * factor));
  board.tx = px - (px - board.tx) * (next / board.scale);
  board.ty = py - (py - board.ty) * (next / board.scale);
  board.scale = next;
  applyTransform();
}

function fitBoard() {
  const els = [...$("#board-cards").children];
  if (!els.length) { board.scale = 1; board.tx = board.ty = 40; return applyTransform(); }
  const minX = Math.min(...els.map((e) => e.offsetLeft)), minY = Math.min(...els.map((e) => e.offsetTop));
  const maxX = Math.max(...els.map((e) => e.offsetLeft + e.offsetWidth));
  const maxY = Math.max(...els.map((e) => e.offsetTop + e.offsetHeight));
  const vw = viewport.clientWidth, vh = viewport.clientHeight, pad = 40;
  board.scale = Math.min(1, (vw - pad * 2) / (maxX - minX), (vh - pad * 2) / (maxY - minY));
  board.tx = (vw - (maxX - minX) * board.scale) / 2 - minX * board.scale;
  board.ty = pad - minY * board.scale;
  applyTransform();
}

viewport.addEventListener("wheel", (e) => {
  e.preventDefault();
  zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
}, { passive: false });

const zoomCenter = (f) => {
  const r = viewport.getBoundingClientRect();
  zoomAt(f, r.left + r.width / 2, r.top + r.height / 2);
};
$("#zoom-in").addEventListener("click", () => zoomCenter(1.25));
$("#zoom-out").addEventListener("click", () => zoomCenter(0.8));
$("#zoom-fit").addEventListener("click", fitBoard);
$("#show-suggestions").addEventListener("change", (e) => {
  try { localStorage.setItem("curio.suggest", e.target.checked ? "on" : "off"); } catch {}
  drawLinks();
});

// ---------- dragging: cards, connections, background ----------
let drag = null;

viewport.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || e.target.closest(".link-label, .suggest-add")) return;
  hideLinkMenu();
  const handle = e.target.closest(".handle");
  const el = e.target.closest(".bcard");
  if (handle && el) {
    drag = { mode: "connect", from: Number(el.dataset.id) };
  } else if (el) {
    const c = board.cards.find((x) => x.id == el.dataset.id);
    drag = { mode: "move", card: c, el, sx: e.clientX, sy: e.clientY, ox: c.x, oy: c.y, moved: false };
    el.classList.add("dragging");
  } else {
    drag = { mode: "pan", sx: e.clientX, sy: e.clientY, ox: board.tx, oy: board.ty };
    viewport.classList.add("panning");
  }
  viewport.setPointerCapture(e.pointerId);
  e.preventDefault();
});

viewport.addEventListener("pointermove", (e) => {
  if (!drag) return;
  if (drag.mode === "move") {
    const dx = (e.clientX - drag.sx) / board.scale, dy = (e.clientY - drag.sy) / board.scale;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    drag.card.x = drag.ox + dx;
    drag.card.y = drag.oy + dy;
    drag.el.style.left = drag.card.x + "px";
    drag.el.style.top = drag.card.y + "px";
    drawLinks();
  } else if (drag.mode === "connect") {
    const a = center(drag.from), p = toWorld(e.clientX, e.clientY);
    drawLinks({ x1: a.x, y1: a.y, x2: p.x, y2: p.y });
    document.querySelectorAll(".bcard.target").forEach((x) => x.classList.remove("target"));
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest(".bcard");
    if (over && over.dataset.id != drag.from) over.classList.add("target");
  } else {
    board.tx = drag.ox + e.clientX - drag.sx;
    board.ty = drag.oy + e.clientY - drag.sy;
    applyTransform();
  }
});

viewport.addEventListener("pointerup", async (e) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  viewport.classList.remove("panning");
  document.querySelectorAll(".bcard.dragging, .bcard.target").forEach((x) => x.classList.remove("dragging", "target"));

  if (d.mode === "move") {
    if (d.moved) savePositions(Number(state.collection || 0), [d.card]);
    else openCard(d.card.id);             // a click, not a drag
  } else if (d.mode === "connect") {
    drawLinks();
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest(".bcard");
    if (over && over.dataset.id != d.from) await connect(d.from, Number(over.dataset.id));
  }
});

viewport.addEventListener("pointercancel", () => { drag = null; drawLinks(); });

// ---------- connections ----------
async function connect(a, b) {
  const link = await api("/connections", { method: "POST", body: { from_id: a, to_id: b } });
  await loadBoard();
  showLinkMenu(link.id);                  // let the person name it right away
}

$("#board-labels").addEventListener("click", (e) => {
  const label = e.target.closest(".link-label");
  if (label) return showLinkMenu(Number(label.dataset.link));
  const add = e.target.closest(".suggest-add");
  if (add) connect(Number(add.dataset.a), Number(add.dataset.b));
});

const menu = $("#link-menu");
let menuLink = null;

function showLinkMenu(id) {
  const link = board.connections.find((l) => l.id === id);
  const btn = $(`.link-label[data-link="${id}"]`);
  if (!link || !btn) return;
  menuLink = link;
  const r = btn.getBoundingClientRect();
  menu.hidden = false;
  menu.style.left = Math.min(window.innerWidth - menu.offsetWidth - 8, Math.max(8, r.left + r.width / 2 - menu.offsetWidth / 2)) + "px";
  menu.style.top = r.bottom + 8 + "px";
  $("#link-label").value = link.label;
  $("#link-label").focus();
}

function hideLinkMenu() { menu.hidden = true; menuLink = null; }

async function saveLinkLabel() {
  if (!menuLink) return;
  await api("/connections/" + menuLink.id, { method: "PUT", body: { label: $("#link-label").value.trim() } });
  hideLinkMenu();
  loadBoard();
}

$("#link-save").addEventListener("click", saveLinkLabel);
$("#link-label").addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveLinkLabel();
  if (e.key === "Escape") hideLinkMenu();
});
$("#link-delete").addEventListener("click", async () => {
  if (!menuLink) return;
  await api("/connections/" + menuLink.id, { method: "DELETE" });
  hideLinkMenu();
  loadBoard();
});
document.addEventListener("pointerdown", (e) => {
  if (!menu.hidden && !menu.contains(e.target) && !e.target.closest(".link-label")) hideLinkMenu();
});
