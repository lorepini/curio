"""Curio — a local knowledge-curation app (MVP).

Run:  python3 server.py   then open http://localhost:8000
Pure Python standard library: SQLite storage + TF-IDF similarity for
"related cards" and ranked search.
"""
import html
import json
import math
import re
import sqlite3
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).parent
DB_PATH = ROOT / "curio.db"
STATIC = ROOT / "static"
PORT = 8000

STOPWORDS = set("""
a an the and or but if of to in on at by for with from as is are was were be been being it its
this that these those i you he she we they me my your our their not no so do does did have has had
will would can could should just than then there here what which who whom how why when where all
any some more most very also into about over out up down only own same too s t don
el la los las un una unos unas y o pero de del a en con por para que es son fue ser se lo le les
su sus mi mis tu al como más mas ya no si este esta esto estos estas ese esa eso muy también
""".split())


# ---------- database ----------

def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    with db() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS cards (
            id INTEGER PRIMARY KEY,
            type TEXT NOT NULL,            -- quote | link | video | note
            content TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            url TEXT NOT NULL DEFAULT '',
            note TEXT NOT NULL DEFAULT '',
            image TEXT NOT NULL DEFAULT '',
            clip_start INTEGER,            -- video clip, in seconds
            clip_end INTEGER,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS collections (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS card_collections (
            card_id INTEGER REFERENCES cards(id) ON DELETE CASCADE,
            collection_id INTEGER REFERENCES collections(id) ON DELETE CASCADE,
            PRIMARY KEY (card_id, collection_id)
        );
        -- whiteboard: where each card sits on each board (collection_id 0 = main board)
        CREATE TABLE IF NOT EXISTS board_positions (
            collection_id INTEGER NOT NULL,
            card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
            x REAL NOT NULL,
            y REAL NOT NULL,
            PRIMARY KEY (collection_id, card_id)
        );
        -- connections you draw between ideas (stored with from_id < to_id)
        CREATE TABLE IF NOT EXISTS connections (
            id INTEGER PRIMARY KEY,
            from_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
            to_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
            label TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            UNIQUE (from_id, to_id)
        );
        """)
        # migrate older databases
        cols = [r[1] for r in conn.execute("PRAGMA table_info(cards)")]
        if "image" not in cols:
            conn.execute("ALTER TABLE cards ADD COLUMN image TEXT NOT NULL DEFAULT ''")
        for col in ("clip_start", "clip_end"):
            if col not in cols:
                conn.execute(f"ALTER TABLE cards ADD COLUMN {col} INTEGER")
        # fill in metadata for links saved before we could read it (e.g. YouTube)
        stale = conn.execute(
            "SELECT id, url FROM cards WHERE type = 'link' AND url != '' AND (title = '' OR title = url OR image = '')"
        ).fetchall()
        for cid, url in stale:
            meta = fetch_meta(url)
            if meta["title"] or meta["image"]:
                conn.execute("UPDATE cards SET type = ?, title = ?, content = CASE WHEN content = '' THEN ? ELSE content END,"
                             " image = ? WHERE id = ?",
                             (meta["type"], meta["title"] or url, meta["description"], meta["image"], cid))


def seconds(v):
    """Clip times arrive as seconds (int) or empty; store NULL for 'no clip'."""
    if v in (None, ""):
        return None
    v = int(v)
    if v < 0:
        raise ValueError("clip time must be positive")
    return v


def url_start_time(url):
    """YouTube share links carry ?t=90 or ?t=1m30s — use it as the clip start."""
    m = re.search(r"[?&#]t=(?:(\d+)h)?(?:(\d+)m)?(\d+)?s?\b", url)
    if not m or not any(m.groups()):
        return None
    h, mi, se = (int(x or 0) for x in m.groups())
    return h * 3600 + mi * 60 + se


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def card_dict(conn, row):
    d = dict(row)
    d["collections"] = [r[0] for r in conn.execute(
        "SELECT collection_id FROM card_collections WHERE card_id = ?", (row["id"],))]
    return d


# ---------- similarity (TF-IDF) ----------

def tokenize(text):
    return [w for w in re.findall(r"[a-záéíóúñü0-9]+", text.lower())
            if len(w) > 2 and w not in STOPWORDS]


def card_text(c):
    return " ".join([c["title"], c["content"], c["note"], c["url"]])


def build_index(cards):
    docs = {c["id"]: Counter(tokenize(card_text(c))) for c in cards}
    n = len(docs) or 1
    df = Counter(t for tf in docs.values() for t in tf)
    idf = {t: math.log((1 + n) / (1 + d)) + 1 for t, d in df.items()}
    vecs = {}
    for cid, tf in docs.items():
        v = {t: (1 + math.log(f)) * idf[t] for t, f in tf.items()}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1
        vecs[cid] = {t: x / norm for t, x in v.items()}
    return vecs, idf


def cosine(a, b):
    if len(a) > len(b):
        a, b = b, a
    return sum(x * b.get(t, 0) for t, x in a.items())


def suggest_connections(conn, ids, existing, per_card=2, threshold=0.12):
    """Pairs of cards on a board that look related but aren't connected yet."""
    vecs, _ = build_index(conn.execute("SELECT * FROM cards").fetchall())
    taken = {(c["from_id"], c["to_id"]) for c in existing}
    pairs = {}
    for a in ids:
        scored = sorted(((cosine(vecs[a], vecs[b]), b) for b in ids if b != a), reverse=True)
        for score, b in scored[:per_card]:
            key = (min(a, b), max(a, b))
            if score >= threshold and key not in taken:
                pairs[key] = round(score, 3)
    return [{"from_id": a, "to_id": b, "score": sc}
            for (a, b), sc in sorted(pairs.items(), key=lambda x: -x[1])[:60]]


def card_connections(conn, card_id):
    rows = conn.execute("SELECT * FROM connections WHERE from_id = ? OR to_id = ?", (card_id, card_id)).fetchall()
    out = []
    for r in rows:
        other = r["to_id"] if r["from_id"] == card_id else r["from_id"]
        card = conn.execute("SELECT * FROM cards WHERE id = ?", (other,)).fetchone()
        out.append({"id": r["id"], "label": r["label"], "card": card_dict(conn, card)})
    return out


def related_cards(conn, card_id, limit=6):
    cards = conn.execute("SELECT * FROM cards").fetchall()
    vecs, _ = build_index(cards)
    target = vecs.get(card_id)
    if not target:
        return []
    scored = [(cosine(target, v), cid) for cid, v in vecs.items() if cid != card_id]
    scored = [s for s in sorted(scored, reverse=True) if s[0] > 0.05][:limit]
    by_id = {c["id"]: c for c in cards}
    return [dict(card_dict(conn, by_id[cid]), score=round(s, 3)) for s, cid in scored]


def search_cards(conn, query):
    cards = conn.execute("SELECT * FROM cards").fetchall()
    vecs, idf = build_index(cards)
    q = Counter(tokenize(query))
    qv = {t: idf.get(t, 0) for t in q}
    q_lower = query.lower().strip()
    results = []
    for c in cards:
        score = cosine(qv, vecs[c["id"]])
        if q_lower and q_lower in card_text(c).lower():
            score += 1  # exact phrase boost
        if score > 0:
            results.append((score, c))
    results.sort(key=lambda x: -x[0])
    return [card_dict(conn, c) for _, c in results]


# ---------- link metadata ----------

OEMBED = [
    (re.compile(r"https?://(www\.|m\.)?(youtube\.com|youtu\.be)/"), "https://www.youtube.com/oembed?format=json&url="),
    (re.compile(r"https?://(www\.)?vimeo\.com/"), "https://vimeo.com/api/oembed.json?url="),
]


def get(url, limit=300_000):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 Curio"})
    with urllib.request.urlopen(req, timeout=6) as r:
        return r.read(limit).decode("utf-8", "ignore")


def fetch_meta(url):
    """Return {type, title, description, image} for a URL. Never raises."""
    out = {"type": "link", "title": "", "description": "", "image": ""}
    # Video sites: use their official oEmbed API (page scraping gets blocked)
    for pattern, endpoint in OEMBED:
        if pattern.match(url):
            try:
                d = json.loads(get(endpoint + urllib.parse.quote(url, safe="")))
                author = d.get("author_name", "")
                out.update(type="video", title=d.get("title", ""), image=d.get("thumbnail_url", ""),
                           description=f"{author} · {d.get('provider_name', '')}" if author else "")
            except Exception:
                out["type"] = "video"
            return out
    try:
        page = get(url)
    except Exception:
        return out

    def meta(prop):
        m = re.search(r'<meta[^>]+(?:property|name)=["\']%s["\'][^>]+content=["\']([^"\']*)' % prop, page, re.I) \
            or re.search(r'<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:property|name)=["\']%s["\']' % prop, page, re.I)
        return html.unescape(m.group(1)).strip() if m else ""

    title = meta("og:title")
    if not title:
        m = re.search(r"<title[^>]*>(.*?)</title>", page, re.I | re.S)
        title = html.unescape(m.group(1)).strip() if m else ""
    image = meta("og:image") or meta("twitter:image")
    if image:
        image = urllib.parse.urljoin(url, image)
    out.update(title=title[:300], description=(meta("og:description") or meta("description"))[:1000], image=image)
    return out


# ---------- HTTP ----------

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(STATIC), **kw)

    def log_message(self, fmt, *args):
        pass

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def route(self, method):
        parsed = urlparse(self.path)
        parts = [p for p in parsed.path.split("/") if p]
        if not parts or parts[0] != "api":
            return False
        qs = parse_qs(parsed.query)
        try:
            with db() as conn:
                self.dispatch(conn, method, parts[1:], qs)
        except KeyError:
            self.send_json({"error": "not found"}, 404)
        except (ValueError, json.JSONDecodeError) as e:
            self.send_json({"error": str(e)}, 400)
        return True

    def dispatch(self, conn, method, p, qs):
        # /api/cards
        if p == ["cards"] and method == "GET":
            q = qs.get("q", [""])[0]
            coll = qs.get("collection", [""])[0]
            if q:
                cards = search_cards(conn, q)
            else:
                cards = [card_dict(conn, r) for r in
                         conn.execute("SELECT * FROM cards ORDER BY created_at DESC, id DESC")]
            if coll:
                cards = [c for c in cards if int(coll) in c["collections"]]
            return self.send_json(cards)

        if p == ["cards"] and method == "POST":
            b = self.read_json()
            ctype = b.get("type") or "note"
            if ctype not in ("quote", "link", "video", "note"):
                raise ValueError("bad type")
            title, content, url = b.get("title", ""), b.get("content", ""), b.get("url", "")
            image = ""
            if ctype in ("link", "video") and url:
                meta = fetch_meta(url)
                ctype, image = meta["type"], meta["image"]
                title, content = title or meta["title"] or url, content or meta["description"]
            if not (content or url or title):
                raise ValueError("empty card")
            start, end = seconds(b.get("clip_start")), seconds(b.get("clip_end"))
            if ctype == "video" and start is None:
                start = url_start_time(url)
            cur = conn.execute(
                "INSERT INTO cards (type, content, title, url, note, image, clip_start, clip_end, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                (ctype, content, title, url, b.get("note", ""), image, start, end, now()))
            for cid in b.get("collections", []):
                conn.execute("INSERT OR IGNORE INTO card_collections VALUES (?,?)", (cur.lastrowid, cid))
            row = conn.execute("SELECT * FROM cards WHERE id = ?", (cur.lastrowid,)).fetchone()
            return self.send_json(card_dict(conn, row), 201)

        if len(p) == 2 and p[0] == "cards":
            cid = int(p[1])
            row = conn.execute("SELECT * FROM cards WHERE id = ?", (cid,)).fetchone()
            if not row:
                raise KeyError
            if method == "GET":
                return self.send_json(dict(card_dict(conn, row), related=related_cards(conn, cid),
                                           connections=card_connections(conn, cid)))
            if method == "PUT":
                b = self.read_json()
                fields = {k: b[k] for k in ("content", "title", "url", "note") if k in b}
                fields.update({k: seconds(b[k]) for k in ("clip_start", "clip_end") if k in b})
                if fields.get("clip_start") is not None and fields.get("clip_end") is not None \
                        and fields["clip_end"] <= fields["clip_start"]:
                    raise ValueError("the clip must end after it starts")
                if fields:
                    conn.execute("UPDATE cards SET %s WHERE id = ?" % ", ".join(f"{k} = ?" for k in fields),
                                 (*fields.values(), cid))
                if "collections" in b:
                    conn.execute("DELETE FROM card_collections WHERE card_id = ?", (cid,))
                    for coll in b["collections"]:
                        conn.execute("INSERT OR IGNORE INTO card_collections VALUES (?,?)", (cid, coll))
                row = conn.execute("SELECT * FROM cards WHERE id = ?", (cid,)).fetchone()
                return self.send_json(card_dict(conn, row))
            if method == "DELETE":
                conn.execute("DELETE FROM cards WHERE id = ?", (cid,))
                return self.send_json({"ok": True})

        # /api/collections
        if p == ["collections"] and method == "GET":
            rows = conn.execute("""
                SELECT c.*, COUNT(cc.card_id) AS count FROM collections c
                LEFT JOIN card_collections cc ON cc.collection_id = c.id
                GROUP BY c.id ORDER BY c.name COLLATE NOCASE""")
            return self.send_json([dict(r) for r in rows])

        if p == ["collections"] and method == "POST":
            b = self.read_json()
            name = (b.get("name") or "").strip()
            if not name:
                raise ValueError("name required")
            cur = conn.execute("INSERT INTO collections (name, description, created_at) VALUES (?,?,?)",
                               (name, b.get("description", ""), now()))
            return self.send_json({"id": cur.lastrowid, "name": name, "count": 0}, 201)

        if len(p) == 2 and p[0] == "collections" and method == "DELETE":
            conn.execute("DELETE FROM collections WHERE id = ?", (int(p[1]),))
            conn.execute("DELETE FROM board_positions WHERE collection_id = ?", (int(p[1]),))
            return self.send_json({"ok": True})

        # /api/board?collection=ID  (no collection = main board)
        if p == ["board"] and method == "GET":
            coll = int(qs.get("collection", ["0"])[0] or 0)
            if coll:
                rows = conn.execute("""SELECT c.* FROM cards c JOIN card_collections cc ON cc.card_id = c.id
                                       WHERE cc.collection_id = ? ORDER BY c.created_at, c.id""", (coll,)).fetchall()
            else:
                rows = conn.execute("SELECT * FROM cards ORDER BY created_at, id").fetchall()
            pos = {r["card_id"]: (r["x"], r["y"]) for r in
                   conn.execute("SELECT * FROM board_positions WHERE collection_id = ?", (coll,))}
            cards = [dict(r, x=pos.get(r["id"], (None, None))[0], y=pos.get(r["id"], (None, None))[1]) for r in rows]
            ids = [r["id"] for r in rows]
            idset = set(ids)
            links = [dict(r) for r in conn.execute("SELECT * FROM connections")
                     if r["from_id"] in idset and r["to_id"] in idset]
            return self.send_json({"cards": cards, "connections": links,
                                   "suggestions": suggest_connections(conn, ids, links)})

        if p == ["board"] and method == "PUT":
            b = self.read_json()
            coll = int(b.get("collection") or 0)
            for item in b.get("positions", []):
                conn.execute("INSERT OR REPLACE INTO board_positions VALUES (?,?,?,?)",
                             (coll, int(item["card_id"]), float(item["x"]), float(item["y"])))
            return self.send_json({"ok": True})

        # /api/connections
        if p == ["connections"] and method == "POST":
            b = self.read_json()
            a, z = sorted((int(b["from_id"]), int(b["to_id"])))
            if a == z:
                raise ValueError("a card can't connect to itself")
            for cid in (a, z):
                if not conn.execute("SELECT 1 FROM cards WHERE id = ?", (cid,)).fetchone():
                    raise KeyError
            conn.execute("INSERT OR IGNORE INTO connections (from_id, to_id, label, created_at) VALUES (?,?,?,?)",
                         (a, z, b.get("label", ""), now()))
            row = conn.execute("SELECT * FROM connections WHERE from_id = ? AND to_id = ?", (a, z)).fetchone()
            return self.send_json(dict(row), 201)

        if len(p) == 2 and p[0] == "connections":
            lid = int(p[1])
            if not conn.execute("SELECT 1 FROM connections WHERE id = ?", (lid,)).fetchone():
                raise KeyError
            if method == "PUT":
                conn.execute("UPDATE connections SET label = ? WHERE id = ?", (self.read_json().get("label", ""), lid))
                return self.send_json(dict(conn.execute("SELECT * FROM connections WHERE id = ?", (lid,)).fetchone()))
            if method == "DELETE":
                conn.execute("DELETE FROM connections WHERE id = ?", (lid,))
                return self.send_json({"ok": True})

        raise KeyError

    def do_GET(self):
        if not self.route("GET"):
            if urlparse(self.path).path == "/capture":
                self.path = "/capture.html"
            super().do_GET()

    def do_POST(self):
        if not self.route("POST"):
            self.send_error(404)

    def do_PUT(self):
        if not self.route("PUT"):
            self.send_error(404)

    def do_DELETE(self):
        if not self.route("DELETE"):
            self.send_error(404)


if __name__ == "__main__":
    init_db()
    print(f"Curio running at http://localhost:{PORT}")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
