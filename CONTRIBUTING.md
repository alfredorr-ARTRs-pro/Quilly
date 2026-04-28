# Contributing to Quilly

Thanks for your interest in contributing to Quilly. Whether it's a bug report, a new feature, a documentation improvement, or just a kind word — it all helps.

Quilly is maintained by **Alfredo Rapetta** through **A.I.P.S.** ([aips.studio](https://aips.studio)).

## Quick links

- [Report a bug](https://github.com/alfredorr-ARTRs-pro/Quilly/issues/new?template=bug_report.yml)
- [Request a feature](https://github.com/alfredorr-ARTRs-pro/Quilly/issues/new?template=feature_request.yml)
- [Ask a question](https://github.com/alfredorr-ARTRs-pro/Quilly/discussions)
- [Report a vulnerability](SECURITY.md)

## Ways to contribute

- **Report bugs** — clear reproduction steps are gold
- **Suggest features** — open a discussion first for bigger ideas
- **Improve documentation** — typos, clarifications, better examples, more screenshots
- **Translate** — wake-word and UI translations are welcome
- **Test** — try the latest release on your hardware and report compatibility

## Development setup

### Prerequisites

- **Windows 10 or 11** (64-bit) — Quilly is Windows-only for now
- **Node.js 18+** — [download](https://nodejs.org)
- **Git** — [download](https://git-scm.com)

### Clone and run

```bash
git clone https://github.com/alfredorr-ARTRs-pro/Quilly.git
cd Quilly
npm install
npm run electron:dev
```

The app will launch in development mode with hot-reloading for the React renderer.

### Build a local installer

```bash
npm run dist
```

Output lands in `release/`.

### Project structure

```
electron/       # Main process (Node): IPC handlers, state machine, LLM pipeline
src/            # Renderer process (React): UI, dashboard, settings, indicator
public/         # Static assets (icon, logo)
docs/images/    # Screenshots and demo assets for documentation
build/          # electron-builder resources
```

Key files:

- `electron/main.cjs` — main process entry, IPC handlers, hotkey registration
- `electron/preload.cjs` — IPC bridge exposed to the renderer
- `electron/pipeline.cjs` — LLM intent-routing and prompt chain
- `src/pages/` — renderer UI pages (Dashboard, Indicator, ReviewPopup)

## Pull-request process

1. **Fork** the repo and create a branch for your change
2. **Write a clear commit message** — explain *why*, not just *what*
3. **Test your change** — run `npm run electron:dev` and verify the affected area
4. **Build the installer** if your change might affect packaging — `npm run dist`
5. **Open a pull request** linking to any related issue
6. **Respond to review** — maintainers may request changes

For large changes, **open an issue or discussion first** so we can align on approach before you spend time coding.

## Commit style

Follow [Conventional Commits](https://www.conventionalcommits.org/) where reasonable:

```
feat(hotkeys): add customizable wake-word timeout
fix(indicator): prevent bar from growing on repeated uses
docs(readme): clarify install instructions
```

Not strict — clarity matters more than format.

## Code style

- **JavaScript / React** — follow existing patterns; ESLint catches most issues (`npm run lint`)
- **No heavy comments** — prefer clear names over comments
- **No new dependencies** without discussion — keep the install small

## Contributor License Agreement

This project uses a lightweight contributor agreement to preserve its long-term future. **By opening a pull request, you agree to the following:**

1. Your contribution is your own original work, or you have the right to submit it
2. Your contribution is licensed to this project under the **MIT License**
3. You grant **A.I.P.S. (Alfredo Rapetta)** a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, modify, and sublicense your contribution — including under other licenses in the future (such as commercial licenses for a potential premium edition of Quilly)

**Your contribution stays yours.** You retain all rights to use it elsewhere however you like. This agreement only grants A.I.P.S. broad rights for this specific project.

**Why this matters:** it lets A.I.P.S. potentially offer paid support or a premium edition of Quilly in the future without needing to track down every past contributor for re-licensing permission. The free MIT version of Quilly always stays free.

If you have concerns about this, please open a [discussion](https://github.com/alfredorr-ARTRs-pro/Quilly/discussions) before submitting a PR — happy to talk it through.

## Code of Conduct

Participation in this project is governed by our [Code of Conduct](CODE_OF_CONDUCT.md). Be kind. Be patient. Assume good faith.

## Questions?

- Technical questions about the code → [GitHub Discussions](https://github.com/alfredorr-ARTRs-pro/Quilly/discussions)
- Collaboration or business inquiries → [aips.studio](https://aips.studio)

Thanks again for contributing.
