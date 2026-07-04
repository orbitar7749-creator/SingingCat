# SingingCat
# Pitch Lab — Phase 1

A live vocal pitch monitor: sing into your mic and watch a scrolling pitch trace,
with a note/frequency readout and a session log.

## Files
- `index.html` — page structure
- `style.css` — dark instrument-panel styling
- `script.js` — mic input, pitch detection, canvas drawing, session log

No build step, no dependencies. These three files are the entire site.

## How to run locally
Just double-click `index.html`... except the mic **won't work** that way,
because browsers only allow microphone access on HTTPS or `localhost`.

To test locally with mic access:
1. Open a terminal in this folder
2. Run: `python3 -m http.server 8000`
3. Open `http://localhost:8000` in your browser

## How to deploy to GitHub Pages
1. Create a new repository on GitHub (e.g. `pitch-lab`)
2. Put `index.html`, `style.css`, and `script.js` in the **root** of the repo
   (not inside a subfolder — GitHub Pages looks for `index.html` at the top level by default)
3. Push to GitHub:
   ```
   git init
   git add index.html style.css script.js
   git commit -m "Phase 1: live mic pitch tracker"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/pitch-lab.git
   git push -u origin main
   ```
4. On GitHub: go to **Settings → Pages**
5. Under "Build and deployment", set **Source: Deploy from a branch**
6. Set **Branch: main**, folder: **/ (root)** → Save
7. Wait ~1 minute, then visit `https://YOUR_USERNAME.github.io/pitch-lab/`
8. Allow microphone access when your browser prompts you — GitHub Pages is HTTPS by default, so mic access will work.

## What to test
- Click **START** (or press Space) → browser should prompt for mic permission
- Hum or sing a steady note → the note name, frequency, and cents readout should update, and a green trace should scroll across the graph
- Click **STOP** (or press Space again) → a new entry should appear in the Session Log
- Refresh the page → the Session Log should still show past sessions (saved in your browser's local storage)

If anything looks wrong or throws a browser console error (right-click → Inspect → Console),
paste it back to me exactly as shown — that's usually a one-line fix.

## Next: Phase 2
Song upload + playback, so we can start extracting a reference pitch line from an actual track.
