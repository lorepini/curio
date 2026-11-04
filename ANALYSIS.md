# Sublime (sublime.app) — Product Teardown

Goal: understand how Sublime works from the outside (features, UX, likely architecture)
so we can build our own original knowledge-curation app. No code or assets are copied.

## 1. What Sublime is

A "second brain" for collecting ideas from around the internet. Its pitch is
"no tags, no folders to maintain": you save things and AI surfaces connections.
Unlike solo note apps (Notion, Obsidian), it's **social**: your saved ideas
connect to other people's public libraries.

## 2. Feature map

| Area | Feature | Notes |
|---|---|---|
| **Capture** | Browser extension | Save a page, a highlighted quote, or an image in one click |
| | Web + iOS app | Paste text/links, write notes |
| | Imports | Kindle / Readwise highlights, bookmarks (verify current list) |
| **Core object** | **Card** | Everything saved is a card: quote, link, image, note, file |
| | Card metadata | Source URL, title, author, thumbnail, your own note |
| **Organize** | **Collections** | Topic/project groups; one card can live in many; private or public |
| | No tags | Organization comes from search + AI, not manual tagging |
| **Discover** | **Related ideas** | Opening a card shows conceptually similar cards (yours + community) |
| | Smart search | Semantic (meaning-based) search, not just keywords |
| | Community | Follow people, browse public collections, save others' cards |
| **AI** | Ask / chat with your library | Answers grounded in your saved cards |
| **Business** | Freemium | Pro tier unlocks AI features / limits |

## 3. Core UX flows

1. **Capture**: highlight text on any page → extension → card created with source attached.
2. **Revisit**: library is a visual masonry grid of cards (Pinterest-like), newest first.
3. **Connect**: open a card → "related" panel shows similar ideas → add to a collection.
4. **Explore**: browse others' public collections → save cards into your own.

What makes it feel good: very low-friction capture, visual layout, and the "serendipity"
of related cards. What's weaker (opportunities for us): little structure for
actually *using* ideas (writing, projects), and the social side matters less to
private users.

## 4. Likely architecture (educated guesses)

```
Browser ext / iOS / Web  ──►  API server  ──►  Postgres (cards, collections, users, follows)
                                   │
                                   ├──►  Embedding model (text → vector) on every new card
                                   ├──►  Vector index (pgvector / Pinecone etc.)
                                   │       • related cards = nearest neighbours
                                   │       • smart search = embed query → nearest neighbours
                                   ├──►  Scraper: fetch page title, image, author (OpenGraph)
                                   └──►  LLM for "ask your library" (retrieve cards → answer)
```

Key insight: **"related ideas" and "smart search" are the same mechanism**.
Turn every card into a vector, and find nearest neighbours. Community connections are
the same search run over all public cards.

## 5. Our MVP (built in this folder)

Scope for v0.1 — single user, runs locally, zero dependencies:

- [x] Cards: quote, link, note (auto-detected when you paste)
- [x] Masonry library grid + full-text ranked search
- [x] Collections (a card can be in many)
- [x] Related cards on every card (TF-IDF similarity: a stand-in for embeddings)
- [x] Bookmarklet capture from any web page (stand-in for a browser extension)
- [x] Link metadata (fetches page title/description)

Next steps (v0.2+):
1. Swap TF-IDF for real embeddings (e.g. a Claude/embedding API) → better "related" + semantic search
2. "Ask my library" chat (retrieve top cards → LLM answer with citations)
3. Image cards + Kindle/Readwise import
4. Our differentiator: pick one. Ideas: a writing canvas that pulls in related cards
   as you type, weekly "resurfacing" digest, or Spanish/English bilingual search.
5. Accounts + public collections (the social layer) only once single-player is great.

## Sources
- https://sublimeinternet.substack.com/p/what-does-sublime-actually-do
- https://mindmappingsoftwareblog.com/sublime-review/
- https://myhub.ai/items/a-sublime-looking-future
- https://toolfinder.co/tools/sublime
