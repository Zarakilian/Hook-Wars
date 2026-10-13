# Browser update, 2026-10-13

Prepared from browser split commit 2d74f43, with the completed local work from October 11-12.
Target: public Zarakilian/Hook-Wars main. Steam and Solana repositories are not modified by this update.

## Applied changes

- Shared C: Iron Dock UI: steel/copper palette, angular menu/navigation, Barlow fonts, authored
  hook-across-K logo, original ability SVGs, red/blue team score plates, and clearer shop close control.
- Standard Classic / Advanced hook motion, movement-driven chain/return, empty-return catches,
  deterministic swept clashes, exact range cap, client predicted chain and snapshot link interpolation.
- Returning-hook bot avoidance; disconnect stand-ins use the configured difficulty and rejoin safely.
- Updated field guide, 17 classic-hook regressions, client presentation and server rejoin coverage.
- Local font license notices. Preserved the browser-only package scripts and removal of desktop/.

The browser is Miguel's free demo for the paid Steam game. UI and look and feel should match.
More advanced Steam graphics are future work in the private Steam repository. Final Steam price
and browser content restrictions are not chosen or implemented by this update.
Historical October 12 implementation records include combined-edition and Steam stand-in evidence;
they do not imply those desktop files are present here or that the private repository was updated.

## Verification on this browser checkout

- npm ci: passed; locked dependencies installed, zero reported vulnerabilities.
- npm run check: passed typecheck, 340 tests / zero failures, and production Vite build.
  The removed desktop and Steam-specific suites explain the lower count than the old 435-test tree.
- Production server: node server/index.ts, loopback 127.0.0.1:8086, ECONOMY=off for QA.
- Chrome: actual menu and live 5v5 solo match rendered; movement, hook casts and Bash cooldown,
  keyboard shop, shop close, pause/resume menu and leaving the match checked.
- Menu and solo HUD at 1280x720, 1280x800, 1366x768, 1440x900, 1920x1080,
  1024x768 and 1280x1024: no page overflow or clipped visible buttons.
- Play Online connected to the production server, Quick Play created a 5v5 lobby,
  and its Start Match action reached the game HUD.
- No console errors in the inspected Chrome session. Existing large-bundle warning remains.
- git diff --check passed. The browser runtime files match the completed local shared UI/mechanics
  work; the browser package retains its split scripts.

Protocol 4 requires the client and game server to be updated together. Refresh old clients
after rebuilding/restarting any hosted browser server. This repository update does not deploy hosting.
Internet/NAT play, physical controllers, native Steam, GPU performance and human hook-feel approval
remain outside this local verification. Rollback source: 2d74f43 (also rebuild/restart server and client).

See [UI refinement](ui-concept-c-refinement-2026-10-12.md) and
[hook implementation](hook-improvements-2026-10-12.md) for detailed behavior and prior captures.
