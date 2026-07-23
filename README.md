# Sketch Together

Draw and sketch on top of any webpage — and invite friends to draw with you in real time.

- **Chrome extension** (`extension/`): transparent canvas overlay + floating toolbar (pen, eraser, color, brush size, clear) + popup to create/join rooms.
- **Server** (`server/`): tiny Node.js WebSocket relay that syncs strokes between everyone in a room.

## How it works

1. One person opens a webpage and clicks **Create room on this page** in the extension popup. They get a 6-character room code (e.g. `K7MPX2`).
2. Friends enter that code in their popup. The room is tied to the page URL — if they're on a different page, the popup offers an **Open that page** button.
3. Everyone draws on the same overlay. Strokes sync live; people who join late get the full drawing.

## Setup

### 1. Start the server

```
cd server
npm install
node server.js
```

It listens on `ws://localhost:8787`.

### 2. Load the extension

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select the `extension` folder

### 3. Draw!

- Open any normal website (http/https), click the extension icon, click **Create room on this page**.
- A toolbar appears in the top-right of the page:
  - ✏️ — toggle draw mode on/off (when off, the page is clickable again; **Esc** also turns it off)
  - 🖊️ / 🧽 — pen / eraser (hotkeys **P** and **E** while drawing). The eraser removes a **whole stroke** at once — swipe over any line and it disappears for everyone.
  - ↩️ / ↪️ — undo / redo your own actions (**Ctrl+Z** / **Ctrl+Y** or **Ctrl+Shift+Z**). Undo works for both drawing and erasing, and syncs to everyone.
  - color picker and brush size slider
  - 🗑️ — clear the drawing for everyone
  - the room code (click to copy)
- The popup lets you show/hide the overlay and leave the room.

## Testing multiplayer on one computer

Open two Chrome **profiles** (or a normal + incognito window with the extension allowed in incognito), go to the same URL in both, create a room in one and join with the code in the other.

## Notes & limitations (v1)

- The server keeps drawings in memory only. An empty room is deleted 60 seconds after the last person leaves.
- Drawing coordinates are anchored to the page (they scroll with it), but if two people have very different window widths, a responsive page may reflow and annotations can drift. Works best with similar window sizes.
- Undo/redo history is per person (you undo your own strokes) and is lost after clearing or refreshing the page.
- Everyone connects to the same server address (popup setting, default `ws://localhost:8787`). To draw with people on other computers, run the server somewhere they can all reach and change the address in the popup.
