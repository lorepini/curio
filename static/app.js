const $ = (s, el = document) => el.querySelector(s);
const state = { collection: "", query: "", collections: [] };

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  return res.json();
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };

// Guess the card type from what was pasted
function detectType(text, url) {
  const t = text.trim();
  if (/^https?:\/\/\S+$/.test(t)) return "link";
  if (url) return "quote";
  return t.length > 0 && /^["“«]/.test(t) ? "quote" : "note";
}

const isWeb = (c) => c.type === "link" || c.type === "video";

// 90 -> "1:30", 3725 -> "1:02:05"
function fmtTime(sec) {
  if (sec == null || sec === "") return "";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return (h ? `${h}:${String(m).padStart(2, "0")}` : m) + ":" + String(s).padStart(2, "0");
}
// "1:30" -> 90, "90" -> 90, "" -> null
function parseTime(str) {
  str = String(str).trim();
  if (!str) return null;
  if (!/^\d+(:\d{1,2}){0,2}$/.test(str)) throw new Error(`"${str}" is not a valid time. Use m:ss, like 1:30`);
  return str.split(":").reduce((acc, x) => acc * 60 + Number(x), 0);
}
const hasClip = (c) => c.clip_start != null || c.clip_end != null;
const clipLabel = (c) => `${fmtTime(c.clip_start ?? 0)} – ${c.clip_end != null ? fmtTime(c.clip_end) : "end"}`;

// Turn a YouTube / Vimeo URL into an embeddable player URL (optionally a clip)
function videoInfo(url) {
  let m = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
  if (m) return { provider: "youtube", id: m[1] };
  m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (m) return { provider: "vimeo", id: m[1] };
  return null;
}
function embedURL(url, start, end, autoplay = false) {
  const v = videoInfo(url);
  if (!v) return "";
  if (v.provider === "youtube") {
    const q = new URLSearchParams({ enablejsapi: 1, origin: location.origin, rel: 0 });
    if (start) q.set("start", start);
    if (end) q.set("end", end);
    if (autoplay) q.set("autoplay", 1);
    return `https://www.youtube.com/embed/${v.id}?${q}`;
  }
  // Vimeo supports a start time but not an end time in embeds
  return `https://player.vimeo.com/video/${v.id}${autoplay ? "?autoplay=1" : ""}${start ? `#t=${start}s` : ""}`;
}

function cardHTML(c) {
  const src = c.url ? host(c.url) : c.title;
  const score = c.score != null ? `<span class="score">${Math.round(c.score * 100)}% match</span>` : "";
  const badge = c.type === "video" && hasClip(c) ? `<span class="clip-badge">✂ ${clipLabel(c)}</span>` : "";
  const thumb = c.image
    ? `<div class="thumb ${c.type === "video" ? "play" : ""}"><img src="${esc(c.image)}" alt="" loading="lazy">${badge}</div>`
    : badge;
  return `<div class="card ${c.type}" data-id="${c.id}">
    ${thumb}${score}<div class="type">${c.type}</div>
    ${isWeb(c) ? `<div class="title">${esc(c.title)}</div>` : ""}
    <div class="content">${esc(c.content.length > 400 ? c.content.slice(0, 400) + "…" : c.content)}</div>
    ${src && !isWeb(c) ? `<div class="source">— ${esc(src)}</div>` : ""}
    ${isWeb(c) ? `<div class="source">${esc(host(c.url))}</div>` : ""}
    ${c.note ? `<div class="why">${esc(c.note.length > 200 ? c.note.slice(0, 200) + "…" : c.note)}</div>` : ""}
  </div>`;
}

// ---------- collections ----------
async function loadCollections() {
  state.collections = await api("/collections");
  $("#collection-list").innerHTML = state.collections.map((c) =>
    `<a href="#" class="nav-item ${state.collection == c.id ? "active" : ""}" data-collection="${c.id}">
       <span>${esc(c.name)}</span><span class="count">${c.count}</span></a>`).join("");
  document.querySelector('.nav-item[data-collection=""]').classList.toggle("active", !state.collection);
}

document.addEventListener("click", (e) => {
  const nav = e.target.closest(".nav-item");
  if (nav) {
    e.preventDefault();
    state.collection = nav.dataset.collection;
    loadCollections();
    loadCards();
  }
});

$("#new-collection").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = e.target.name;
  if (!input.value.trim()) return;
  await api("/collections", { method: "POST", body: { name: input.value } });
  input.value = "";
  loadCollections();
});

// ---------- cards ----------
async function loadCards() {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  if (state.collection) params.set("collection", state.collection);
  const cards = await api("/cards?" + params);
  $("#grid").innerHTML = cards.map(cardHTML).join("");
  $("#empty").hidden = cards.length > 0;
  const coll = state.collections.find((c) => c.id == state.collection);
  const label = state.query ? `Results for “${esc(state.query)}”` : coll ? esc(coll.name) : "All cards";
  $("#heading").innerHTML = `${label}<small>${cards.length} card${cards.length === 1 ? "" : "s"}</small>`;
}

$("#grid").addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (card) openCard(card.dataset.id);
});

let searchTimer;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = e.target.value.trim(); loadCards(); }, 200);
});

// ---------- capture ----------
const capture = $("#capture");
capture.content.addEventListener("focus", () => { $(".capture-extra").hidden = false; });
capture.addEventListener("input", () => {
  const type = detectType(capture.content.value, capture.url.value);
  $(".type-hint").textContent = capture.content.value.trim() ? `Will save as: ${type}` : "";
});
capture.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = capture.content.value.trim();
  let url = capture.url.value.trim();
  const type = detectType(text, url);
  let content = text.replace(/^["“«]|["”»]$/g, "");
  if (type === "link") { url = text; content = ""; }
  const body = { type, content, url, title: capture.title.value.trim(), note: capture.note.value.trim() };
  if (state.collection) body.collections = [Number(state.collection)];
  $("button[type=submit]", capture).disabled = true;
  try {
    await api("/cards", { method: "POST", body });
    capture.reset();
    $(".type-hint").textContent = "";
    await Promise.all([loadCards(), loadCollections()]);
  } catch (err) {
    alert(err.message);
  } finally {
    $("button[type=submit]", capture).disabled = false;
  }
});

// ---------- detail view ----------
const dialog = $("#detail");
$(".close", dialog).addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
dialog.addEventListener("close", () => { $("#detail-body").innerHTML = ""; loadCards(); loadCollections(); });

async function openCard(id) {
  const c = await api("/cards/" + id);
  const main = isWeb(c) ? c.title : c.content;
  const sub = isWeb(c) ? c.content : "";
  const video = c.type === "video" && videoInfo(c.url);
  const embed = video && embedURL(c.url, c.clip_start, c.clip_end);
  $("#detail-body").innerHTML = `
    ${embed ? `<div class="player"><iframe id="player" src="${esc(embed)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>
      <div class="clip">
        <span class="clip-label">✂ Clip</span>
        <label>Start <input id="clip-start" value="${fmtTime(c.clip_start)}" placeholder="0:00"></label>
        ${video.provider === "youtube" ? '<button class="btn ghost small" data-now="clip-start" title="Use the moment the video is at now">⏱ Now</button>' : ""}
        <label>End <input id="clip-end" value="${fmtTime(c.clip_end)}" placeholder="end"></label>
        ${video.provider === "youtube" ? '<button class="btn ghost small" data-now="clip-end" title="Use the moment the video is at now">⏱ Now</button>' : ""}
        <button class="btn ghost small" id="clip-play">▶ Play clip</button>
        <button class="btn ghost small" id="clip-clear">Full video</button>
      </div>`
      : c.image ? `<img class="detail-image" src="${esc(c.image)}" alt="">` : ""}
    <div class="detail-main">${c.type === "quote" ? "“" + esc(main) + "”" : esc(main)}</div>
    ${sub ? `<p>${esc(sub)}</p>` : ""}
    <div class="detail-meta">
      ${c.type} · saved ${new Date(c.created_at).toLocaleDateString()}
      ${c.title && !isWeb(c) ? " · " + esc(c.title) : ""}
      ${c.url ? ` · <a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(host(c.url))} ↗</a>` : ""}
    </div>
    <div class="section-title">Collections</div>
    <div class="chips" id="detail-colls">
      ${state.collections.map((k) =>
        `<button class="chip ${c.collections.includes(k.id) ? "on" : ""}" data-coll="${k.id}">${esc(k.name)}</button>`).join("")
      || '<span class="type-hint">Create a collection in the sidebar first.</span>'}
    </div>
    <div class="section-title">Why I saved this</div>
    <textarea id="detail-note" placeholder="What caught your attention? How might you use it?">${esc(c.note)}</textarea>
    <div class="detail-actions">
      <button class="btn ghost" id="detail-delete">Delete</button>
      <button class="btn" id="detail-save">Save</button>
    </div>
    <div class="section-title">Related ideas</div>
    <div class="related">${c.related.length ? c.related.map(cardHTML).join("")
      : '<p class="type-hint">No related cards yet. Save more ideas and connections will appear.</p>'}</div>`;

  $("#detail-colls").addEventListener("click", async (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    chip.classList.toggle("on");
    const ids = [...document.querySelectorAll("#detail-colls .chip.on")].map((x) => Number(x.dataset.coll));
    await api("/cards/" + id, { method: "PUT", body: { collections: ids } });
  });
  const readClip = () => ({ clip_start: parseTime($("#clip-start").value), clip_end: parseTime($("#clip-end").value) });
  $("#detail-save").addEventListener("click", async () => {
    try {
      const body = { note: $("#detail-note").value };
      if (embed) Object.assign(body, readClip());
      await api("/cards/" + id, { method: "PUT", body });
      $("#detail-save").textContent = "Saved ✓";
      setTimeout(() => { $("#detail-save") && ($("#detail-save").textContent = "Save"); }, 1500);
    } catch (err) {
      alert(err.message);
    }
  });
  if (embed) {
    // Ask the YouTube player what second it's at (postMessage API, no extra library)
    const iframe = $("#player");
    let currentTime = 0;
    window.onmessage = (e) => {
      if (e.source !== iframe.contentWindow) return;
      try {
        const d = JSON.parse(e.data);
        if (d.info && typeof d.info.currentTime === "number") currentTime = d.info.currentTime;
      } catch {}
    };
    iframe.addEventListener("load", () =>
      iframe.contentWindow.postMessage(JSON.stringify({ event: "listening", id: "player" }), "*"));
    dialog.querySelectorAll("[data-now]").forEach((b) => b.addEventListener("click", () => {
      $("#" + b.dataset.now).value = fmtTime(Math.floor(currentTime));
    }));
    $("#clip-play").addEventListener("click", () => {
      try {
        const { clip_start, clip_end } = readClip();
        iframe.src = embedURL(c.url, clip_start, clip_end, true);
      } catch (err) { alert(err.message); }
    });
    $("#clip-clear").addEventListener("click", () => {
      $("#clip-start").value = ""; $("#clip-end").value = "";
      iframe.src = embedURL(c.url, null, null, true);
    });
  }
  $("#detail-delete").addEventListener("click", async () => {
    if (!confirm("Delete this card?")) return;
    await api("/cards/" + id, { method: "DELETE" });
    dialog.close();
  });
  $(".related", dialog).addEventListener("click", (e) => {
    const card = e.target.closest(".card");
    if (card) openCard(card.dataset.id);
  });

  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
}

// ---------- bookmarklet ----------
$("#bookmarklet").href = `javascript:(()=>{const s=String(getSelection()).trim();` +
  `window.open('${location.origin}/capture?text='+encodeURIComponent(s)+'&url='+encodeURIComponent(location.href)` +
  `+'&title='+encodeURIComponent(document.title),'curio','width=520,height=560')})()`;

loadCollections().then(loadCards);
