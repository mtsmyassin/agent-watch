# What ships in this folder, and under which license

The window is one page, `index.html`, written for this mod. It loads two files that sit beside it and nothing from the network.

| File | What it is | Version | License |
| --- | --- | --- | --- |
| `motion.js` | [Motion](https://motion.dev), the animation engine: springs that keep their velocity when interrupted | 14.12.0, the unmodified `dist/motion.js` of the npm package `motion` | MIT, `licenses/motion-LICENSE.md` |
| `fonts.css` | Inter and JetBrains Mono, latin subset, variable weight, embedded as data so no font is fetched | as served by Google Fonts on 2026-11-12 | SIL Open Font License 1.1, `licenses/Inter-OFL.txt` and `licenses/JetBrainsMono-OFL.txt` |

## Checking `motion.js`

The file is byte for byte the one in the registry's tarball:

- tarball `motion-14.12.0.tgz`, integrity `sha512-cxD0c0yGXo/mzPgveXMsXGl138UNsRit9XgInK8kThtDsrvIkhlAR9b6WYoAm7EmKWToMFx6v/G8i0Zjv+2uoA==`
- `dist/motion.js`, sha256 `a18fc08eb11c67658b34270bb71bc4ba806c87dbc1b720d7acd38c437844eee7`

It was read for anything that reaches outside the page before it was added: it holds no `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `eval`, `new Function`, dynamic `import()`, cookie or storage access. To update it, replace the file with the same path from a newer tarball, check it the same way, and change the numbers above.
