# Strood

Strudel live coding IDE for making music in the browser.

## Quick Start

```bash
cd ~/projects/strood
npm install
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173).

## Songs

Songs are stored as `.strudel` files in the `songs/` directory. The IDE auto-syncs changes between the browser editor and the files on disk, so you can also edit them in any text editor.

## API

The dev server exposes a simple songs API:

- `GET /api/songs` — list all songs
- `GET /api/songs/:name` — read a song
- `PUT /api/songs/:name` — save a song
- `DELETE /api/songs/:name` — delete a song
