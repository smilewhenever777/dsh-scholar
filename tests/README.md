# Plugin regression checks

## Reproduce from a fresh checkout

Use Node.js 20 or newer (the release check was run on Windows with Node.js 24).
Install each plugin's locked dependencies and the root browser-test dependencies:

```sh
npm ci
npm ci --prefix dsh-scholar
npm ci --prefix dsh-server-dashboard
npm ci --prefix dsh-trajectory
npx playwright install chromium
npm test
npm run check:release
```

On Linux, Playwright may also need browser system dependencies (`npx playwright install --with-deps chromium`).
`npm test` builds all three plugins, runs their smoke/alert checks, then the backend,
credential compatibility, browser, config-contract and scrolling suites. Logs and JSON
results are saved under an ignored `.verify/<timestamp>/` directory; set `DSH_TEST_OUTPUT`
to use a different directory. `npm run build` only builds the three plugins.

`check:release` checks Git candidates (including untracked, non-ignored files), common
secret patterns in the checkout and Git history, public Markdown links, and npm dry-run
package manifests. It does not stage, commit, push or publish. Pattern scanning is not a
guarantee that every type of sensitive information has been detected; review the final diff.

## Individual checks

From the repository root, build `dsh-scholar` and `dsh-server-dashboard`, then run:

```powershell
node --experimental-vm-modules tests/regression.mjs
```

The suite uses real built stores, route handlers, PDF parsing and model orchestration,
with synthetic vault, SSH and model services. It does not contact servers or read
user credentials. It exits nonzero on a failed expectation. Results and retained
synthetic fixtures go to `audit-fix-2026-09-21/`; set `DSH_TEST_OUTPUT` to choose a
different output directory. Run from the repository root because the harness loads
both plugins by repository-relative paths.

Coverage includes credential migration and auth/pin binding, concurrent merge
updates, graph edge ownership, deletion races and stale task generations, bounded
PDF extraction, VLM cancellation, and log observation timestamps. Keep each
plugin's existing smoke/typecheck/build checks as well.

## Interaction repairs

Build all three plugins first, including their client typechecks. From the repository root:

```powershell
$env:DSH_TEST_OUTPUT = 'repair-final-2026-09-21'
node --experimental-vm-modules tests/regression.mjs
node --experimental-vm-modules tests/interaction-backend.mjs
node tests/ui-regression.mjs
node --experimental-vm-modules tests/config-contract.mjs
```

`interaction-backend.mjs` checks partial config updates, revisions, credential identity,
concurrent writers, cache-only previews, late TOFU callbacks, and atomic node/mainline
saves including failed disk writes. `config-contract.mjs` replays the host-edit and
threshold-save requests emitted by the browser against the real backend route.

`ui-fixture.tsx` renders real components with isolated synthetic routes. The browser suite
checks the review reproductions, pending requests, drafts, reference selection, rich-text
attachments, modal focus, keyboard ratings, narrow containers, and enlarged text.
It blocks external network requests and writes screenshots plus JSON results under
`DSH_TEST_OUTPUT`. This does not validate an authenticated DSH host session.

The browser runner uses existing local dependencies. Override `DSH_UI_DEPS` with a
`node_modules` directory containing React, React DOM and esbuild, `DSH_PLAYWRIGHT_PACKAGE`
with an absolute Playwright `package.json` path, and `DSH_CHROME` with a browser executable.
The defaults use root `node_modules` and Playwright's installed Chromium. No private
audit directory or personal absolute path is required. Set `DSH_CHROME` to use an
existing Chrome executable instead of downloading Chromium.

`node tests/library-scroll.mjs` verifies a 40-paper library in a fixed-height,
clipped panel at widths 420, 699, 700 and 1000, with the collection rail open and
closed. It uses real wheel input to reach the last paper and checks the scroll
container again after returning from details. The default output is
`repair-scroll-2026-09-21/`; `DSH_TEST_OUTPUT` can preserve separate before/after runs.
