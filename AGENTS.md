# AGENTS.md

> Korean version: [AGENTS.ko.md](AGENTS.ko.md). Keep both files in sync; this English file is the source of truth for rules.

## Project

`make_emoji` turns user images into KakaoTalk-ready "emoticon-style" images and shows them in a gallery where each item can be copied to the clipboard in one action, then pasted straight into a KakaoTalk chat.

Core flow:

1. User adds an image (file pick / drag-and-drop / paste).
2. App processes it: removes a flat background (e.g. the chat background captured in a screenshot), trims, caps the longest side at 360 px, and stores a transparent PNG.
3. Result appears in a gallery styled after KakaoTalk's emoticon window, previewed on the user's chat background color.
4. One click composites the image onto the user's chat background color at the output canvas size and copies it to the clipboard.

## Background Color (core requirement)

- A transparent PNG is useless: KakaoTalk fills transparency with white/black. The copied image MUST be opaque and painted with the user's own chat background color so it blends in like a real emoticon.
- Each user's chat background differs, so the color is a user setting (color picker, hex, on-screen eyedropper; default KakaoTalk `#BACEE0`).
- Background removal only runs when most of the border is one flat color; photos and scenes are kept as-is. Enclosed pockets are removed only for tinted backgrounds (not white/gray) so eyes and teeth survive.

## Principles

- **Lightweight first.** Prefer the lightest language/runtime that does the job. Minimize dependencies, install steps, and binary/bundle size. Every new dependency needs a reason.
- **Boring and small.** No frameworks or abstractions unless they remove more code than they add.
- **Local only.** Images never leave the user's machine. No network calls, no telemetry.

## Image Size Rules

- KakaoTalk's official emoticon spec is **360×360 px**. Treat this as the reference size.
- Our output is pasted into chat as a **regular image**, not an official emoticon. KakaoTalk renders regular images differently, so the output must be sized/padded so that it **appears at the same visual size and ratio as a real emoticon** in the chat.
- Never stretch: preserve the source aspect ratio, fit inside the target canvas, fill the rest with padding.
- The exact output dimensions and padding must be **calibrated by testing in actual KakaoTalk** (PC and mobile) and recorded here once confirmed. The background is decided (see above).

| Item | Value | Status |
| --- | --- | --- |
| Reference size | 360×360 | KakaoTalk spec |
| Output canvas | Square, default 150×150, padding 4% (user setting) | Needs calibration |
| Background | Opaque, user's chat background color (default `#BACEE0`) | Decided |
| Format | Stored: transparent PNG. Clipboard: opaque bitmap | Decided |

## GUI / Tech Stack

- **Tauri 2** (Rust backend + web UI). Decided with the project owner.
- **Frontend:** plain HTML/CSS/JS (vanilla). No UI framework or bundler unless the owner approves. Image processing runs here on `<canvas>` (`src/imaging.js` holds DOM-free pixel logic).
- **Backend (Rust):** gallery file I/O and clipboard only. Crates: `tauri`, `serde`, `arboard` (clipboard image write). Keep crates minimal and justify each one.
- **Clipboard:** copy processed images as image data (not file paths) so they paste directly into KakaoTalk.
- **Window:** small, resizable; a pin button toggles always-on-top.
- **Theme:** follows the OS light/dark setting automatically (`prefers-color-scheme`). Colors live as CSS variables in `:root`; never hardcode UI colors.

## Build

- Prerequisites (Windows): Rust (MSVC toolchain), Visual Studio Build Tools with the C++ workload, Node.js (only for the Tauri CLI).
- `npm install`, then `npm run dev` to run, `npm run build` to produce `src-tauri/target/release/거지티콘.exe` (no installer bundle).

## Storage

- The gallery is **persistent and folder-based**: one gallery folder on disk is the source of truth.
- Processed images are saved as PNG files in that folder; the gallery lists the folder's contents on startup.
- No database or separate index file unless needed later; the folder itself is the state.
- **Portable:** everything lives in `거지티콘_data/` next to the exe: `settings.json`, the default gallery `gallery/`, and the WebView2 profile `webview/`. Nothing is written to AppData. Moving the exe together with that folder moves the whole app.
- Gallery folder location: default `gallery` (relative paths resolve against the data folder), changeable in settings. Each subfolder is a tab; PNGs in the root form the default tab.

## Documentation Rules

- Rules are written in English in `AGENTS.md`; the Korean mirror is `AGENTS.ko.md`. Any change to one MUST be applied to the other in the same change.
- `CLAUDE.md` only references `AGENTS.md`. Do not add content to it.
- User-facing communication with the project owner is in Korean.
