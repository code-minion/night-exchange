# The Night Exchange — Prototype 1

Cord into jack. A static prototype of the expensive connect moment for [code-minion](https://github.com/code-minion)’s portfolio concept.

**Live:** https://code-minion.github.io/night-exchange/

## What this is

One board, six sample lines, one red cord. Drag (desktop), tap (phone), or press `1`–`6` / arrows + Enter to seat the plug. Esc or Hang up returns the cord to its hook. Sound is off by default (`M` toggles).

Visual Engineer SVGs are inlined and driven through the documented `nx-` state API (`--nx-lit`, `--nx-lamp`, `nx-is-pulse`). Cord physics is a Verlet rope on Canvas2D. No GSAP, no WebGL.

## Run locally

```bash
python3 -m http.server 8744 --directory .
# open http://127.0.0.1:8744/
```

## Licence notes

- Site code: see `LICENSE`.
- Fonts: SIL OFL 1.1 — see `fonts/NOTICE.md` and `fonts/OFL.txt`.
- Board art: original vectors for this prototype (no stock textures).
