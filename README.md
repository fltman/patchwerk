# Patchwerk

[![Support me on Patreon](https://img.shields.io/badge/Patreon-Support%20my%20work-FF424D?style=flat&logo=patreon&logoColor=white)](https://www.patreon.com/AndersBjarby)

A modular visual synth for music. Drop in a track, patch nodes together with
cables, and every shader on screen moves with the kick, the bass line and the
bar — like a wall of Eurorack, except the modules make pictures.

![Patchwerk: the Acid tunnel example patch](docs/screenshot.png)

```bash
npm start          # → http://localhost:8270
```

No build step, no dependencies at runtime: plain ES modules + WebGL2 + Web Audio.
Chrome/Edge/Arc recommended.

## Using it

- **A track goes in.** Drop an audio file anywhere (or *Load track*). It is
  analysed once, up front: tempo, a tracked beat grid, bar phase, kick / snare /
  hat onsets, five frequency bands, slow energy, a log spectrum. Without a file
  you get a built-in acid techno loop. The last track is remembered.
- **Patch.** Double-click the grid or press <kbd>Tab</kbd> to add a node. Drag
  from a jack to a jack. Green cables carry images, orange cables carry
  control signals (0..1) into any slider — or into a dropdown, so a Sequencer can
  switch modes on the bar. A patched slider grows a *mod depth* slider: how far
  the cable pushes it from where you set it.
- **Unplug** by dragging a cable off its input, double-clicking it, or ⌥-clicking it.
- **✦ AI** (⌘K): describe what you want — "a neon tunnel that rushes on the bass and
  flashes on the kick" — and the patch assistant builds it, looks at the result,
  and fixes what's off. Ask for changes the same way. Each AI edit is one ⌘Z.
  Runs Claude Sonnet 5.5 through OpenRouter: `OPENROUTER_API_KEY` must be set
  where you run `npm start` (the key stays on the server; it listens on
  127.0.0.1 only). Override the model with `PATCHWERK_MODEL`.
- **◉ DJ:** let a decision model perform the patch live, on the beat. The assistant
  builds the rig first; see [Live DJ](#live-dj).
- **GLSL tab:** read the shader of any node, *Fork* it into a live-editable GLSL
  node, or write your own — `uniform float p_amount; // 0 1 0.5` in the code
  becomes a patchable slider.
- **Output:** fullscreen (double-click the preview) or ● REC to record video
  with sound. Patches save to the browser automatically; *Save / Open* for files.
- **Send it to other apps:** tick **Syphon** (macOS), **Spout** (Windows) or
  **NDI** under the preview, and the picture shows up as a source called
  *Patchwerk* in Resolume, MadMapper, TouchDesigner, OBS, VDMX and the like. NDI
  also reaches other machines on the network. It runs at the chosen resolution, up
  to 60 fps. See [Syphon, Spout and NDI](#syphon-spout-and-ndi).

<kbd>Space</kbd> play · <kbd>⌫</kbd> delete · <kbd>⌘D</kbd> duplicate ·
<kbd>⌘Z</kbd>/<kbd>⇧⌘Z</kbd> undo/redo · <kbd>F</kbd> frame all · scroll pans,
pinch / ⌘-scroll zooms.

## The rack

| | |
|---|---|
| **Audio** | Track (14 outputs: level, five bands, kick, snare, hat, beat, downbeat, beat/bar phase, energy) · Band (any frequency range) · Clock (1/16 … 4-bar ramps) |
| **Control** | Number · LFO (free or beat-synced) · Wander · Sequencer · Random (S&H) · Envelope · Smooth · Math · Map Range · Gate |
| **Generators** | Solid · Noise · Gradient · Plasma · Voronoi · Stripes · Checker · Truchet · Polygon · Rings · Tunnel · Metaballs · 3D Shape · Lasers · Starfield · Sparks · Sun · Grid Floor · Scanner · Spectrum · Scope · Spectrogram · Ridges · Julia · Text |
| **Effects** | Transform · Feedback · Flow · Datamosh · Kaleidoscope · Mirror · Tile · Polar · Wave Warp · Swirl · Lens · Displace · Blur · Bloom · Zoom Blur · RGB Split · Color Adjust · Gradient Map · Posterize · Invert · Threshold · Pixelate · Halftone · Edges · Glitch · CRT · VHS · Grain · Vignette · Strobe |
| **Mix** | Blend · Crossfade · Mask · Key · Switch · Merge · Video Wall |
| **Code** | GLSL (your own shader) |

## How it works

- `src/audio/` — offline analysis (`analysis.js`, in a worker), a reader that
  answers "what is the music doing at time t" (`features.js`), the transport and
  the demo track. Everything is a function of track time, so scrubbing is exact.
- `src/graph/` — the patch model (topological order, no cycles, snapshot undo),
  the DOM/SVG editor, the add-node menu.
- `src/engine/` — one fullscreen fragment pass per image node into its own
  float framebuffer; control nodes run in JS first. Feedback nodes ping-pong.
  `tap.js` reads the output back for Syphon / Spout / NDI (`server/outputs.mjs`).
- `src/dj/` is the live DJ: `rig.js` checks a rig, `choose.js` turns it into
  questions and answers into moves, `dj.js` runs the loop on the beat grid.
- `src/nodes/` — the node library. **`src/nodes/CONTRACT.md` is the contract**
  for writing nodes (uniform naming, premultiplied alpha, integrated speeds).

## Live DJ

The assistant prepares the set and a decision model performs it. Decision models
are fast but can only pick from options you list, so the two do different jobs:

1. **The assistant builds a rig.** Click **◉ DJ → Build rig…**, add what kind of set
   you want, and press Enter. It patches several looks into one mixer, keeps effects
   ready at zero, writes the moves in plain language, then auditions every move and
   fixes what looks wrong. The example patch **DJ rig** is ready to play as it is.
2. **The DJ plays it.** Press **Start**. On every downbeat it tells the model about
   the music and the picture, and the answer lands on the next downbeat.

Moves only change knobs and cables on modules that are already there, so nothing
compiles during a set and the DJ can't break the patch. The rig is saved with the
patch, and a set adds one undo step when you press Stop.

- **Code decides when, the model decides what.** Each group of moves has its own
  pace, counted from the start of the section, and can also change when a new section
  starts. The model rates the moves; the choice is drawn from those odds, so the
  same moment doesn't always get the same answer, and a move that has been on for a
  long time slowly loses out.
- **It can see ahead.** The track is analysed in advance, so the model is told a
  drop is two bars away. The picture is measured from the output: brightness,
  saturation and motion, never an image.
- **Nothing depends on the network.** A late or failed answer means no change that
  bar, and the picture carries on. After four failures in a row it asks every 8 bars.
  A wrong key or no credit stops the DJ and says so.
- **Code catches a blank picture.** If the output stays black or white for two bars
  while the music plays, every group goes back to its first move.
- **The pads are yours too.** Click one to play it on the next downbeat, ahead of the
  model. With the DJ stopped it plays at once. The bar under a pad shows the model's
  odds, and the panel shows the answer time and what the set has cost.

Measured on an M-series Mac with the 12-module example rig at 1280 × 720: 60 fps,
every move within 0.05 beats of the downbeat, and answers in about 0.45 s, which
leaves plenty of room in a bar. A set costs about a cent an hour on
`inception/mercury-decide`, and building a rig about 8 cents. Set
`PATCHWERK_DJ_MODEL` to try another [decision model](https://openrouter.ai/docs/guides/community/jev);
keep a choice to 26 moves or fewer, because some models refuse more.

Sections are found from how the music changes, and named from energy and whether
the kick plays. Treat the names as hints: they are checked against tracks with a
known arrangement, not against human labels.

## Syphon, Spout and NDI

A web page can't publish video to other apps, so the page reads every finished
frame back from the GPU (asynchronously, already flipped and in BGRA) and streams
it over a WebSocket to the local server, which hands it on:

| | Platform | How |
|---|---|---|
| **Syphon** | macOS | [`@napolab/texture-bridge`](https://github.com/naporin0624/electron-texture-bridge), which bundles Syphon.framework |
| **Spout** | Windows (64-bit) | Spout's own `SpoutLibrary.dll` (2.007.018, in `vendor/spout/`) through [koffi](https://koffi.dev) |
| **NDI** | macOS, Windows, Linux | [`grandi`](https://github.com/tux-tn/grandi), which bundles the NDI runtime |

These are optional dependencies: `npm install` pulls in what your platform
supports, and the server prints which outputs it offers when it starts. Only
pages served by Patchwerk itself may open the stream.

Measured on an Apple M5 Mac with Syphon and NDI both on: Patchwerk keeps
drawing at 60 fps with the example patches at 1280 × 720 and 1920 × 1080, the
readback costs 2–3 ms of main-thread time per frame, and both receivers get
60 fps. `npm run outputs` checks size, orientation, colour and frame rate end to
end. It reads Syphon through Syphon's own OpenGL client (`test/syphon-probe.m`)
and NDI through an NDI receiver.

Notes:
- The stream stops when the tab is hidden, as rendering does. Keep the window
  visible on a screen. Chrome may also pause rendering in a window that is fully
  covered by others; start it with `--disable-backgrounding-occluded-windows` if
  that bites.
- **Spout has not been run yet:** there was no Windows machine to test on. The
  DLL calls were checked against the DLL's own code (see `vendor/spout/README.md`).
  It needs the Microsoft Visual C++ Redistributable (x64). If it fails, the server
  prints why and the switch turns itself off.
- NDI® is a registered trademark of Vizrt NDI AB — [ndi.video](https://ndi.video).

## Tests

```bash
npm test                # analysis calibrated against tracks with known beats, graph model
npm run check:shaders   # compile + render every shader node (NaN / negative / black checks)
npm run smoke           # boot the app headless and play the demo
npm run interact        # drive the editor with a real mouse
npm run presets         # screenshot every example patch → test/out/
npm run perf            # frame cost per example on the real GPU
npm run outputs         # Syphon + NDI end to end on the real GPU (macOS, Google Chrome)
npm run dj              # the live DJ on the real GPU, with forced lateness and failures
npm run dj-live         # the real decision model plays the example rig (a fraction of a cent)
npm run dj-build        # the assistant builds a rig, the DJ plays it (about 8 cents)
npm run ai-live         # the assistant against the real model (spends a few cents)
```

## Making videos

The app has a frame-exact capture mode (`?capture`), so a video's visuals react
to exactly the music under them:

```bash
node tools/bars.mjs song.mp3                       # bar start times + energy, to cut on the one
node tools/record-chat.mjs chat.json "prompt" …    # record a real assistant session for replay
node tools/capture.mjs shots.json                  # render shots → mp4 clips (format in the file header)
```

## License

MIT © 2026 Anders Bjarby
