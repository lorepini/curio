# Curio

A personal "second brain" for collecting ideas from around the internet: quotes, links,
videos and notes. Organize them into collections, and Curio shows you how your ideas connect.

Everything runs on your own computer. Your saved cards stay private in a local file.

## Features
- **Save anything**: quotes, notes, web links (title + preview image fetched automatically)
- **Videos**: YouTube and Vimeo links play inside the app
- **Video clips**: save just a fragment of a video (start / end time)
- **Why notes**: write why you saved something; it shows on the card
- **Collections**: group cards by topic; a card can be in many collections
- **Related ideas**: open a card to see similar cards from your library
- **Whiteboard**: switch to *Board* view to arrange cards freely, draw labeled connections between ideas, and accept suggested connections (one board per collection)
- **Search** across text, titles, notes and links (English + Spanish)
- **Save from any website** with a bookmarklet button

## Install

You only need **Python 3** (version 3.8 or newer). No other installs.

**1. Install Python** (skip if you have it)
- **Windows**: download from https://www.python.org/downloads/ and, during install, tick **"Add Python to PATH"**
- **Mac**: download from https://www.python.org/downloads/ (or `brew install python`)
- **Linux**: usually already installed

**2. Download Curio**
- Easiest: on https://github.com/lorepini/curio, click the green **Code** button → **Download ZIP**, then unzip it
- Or with git: `git clone https://github.com/lorepini/curio.git`

**3. Run it**: open a terminal in the Curio folder and type:
```bash
python server.py
```
(On Mac/Linux, use `python3 server.py` if `python` doesn't work.)

**4. Open** http://localhost:8000 in your browser. Keep the terminal open while you use Curio;
close it (or press `Ctrl+C`) to stop.

## Save from any website
In the left sidebar, drag the orange **"+ Save to Curio"** button to your browser's bookmarks bar.
On any page, select some text (or nothing, to save the whole page) and click the bookmark.
Curio must be running for this to work.

## Your data
Your cards are stored in `curio.db` inside the Curio folder. To back up, copy that file.
It is never uploaded to GitHub.

## Update to the newest version
- ZIP: download again and copy your `curio.db` into the new folder
- git: run `git pull` in the Curio folder

## For developers
- `server.py`: API, SQLite storage, TF-IDF similarity for related ideas and search
- `static/`: web interface (plain HTML / CSS / JavaScript)
- `ANALYSIS.md`: product research behind the app
