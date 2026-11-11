# Testing Orbit

Orbit runs on the farmer's own Windows, macOS or Linux PC. Every platform is tested in GitHub
Actions, so you do not need to own a Windows PC. Your own machine runs only the light suites.

## Suites at a glance

| Suite                                      | Where it lives                                        | Runs locally               | Runs in CI                            |
| ------------------------------------------ | ----------------------------------------------------- | -------------------------- | ------------------------------------- |
| Lint and format (Biome)                    | repo root                                             | `bun run lint`             | `checks`, all 3 OSes                  |
| Typecheck                                  | every package                                         | `bun run typecheck`        | `checks`, all 3 OSes                  |
| Unit tests (bun test, vitest)              | `packages/*/test`, `apps/orbit/test`, `core/api/test` | `bun run test`             | `checks`, all 3 OSes                  |
| Web e2e (Playwright)                       | `packages/e2e/web`                                    | `bun run e2e:web`          | `checks`, all 3 OSes                  |
| Desktop smoke (WebdriverIO + tauri-driver) | `packages/e2e/desktop`                                | **no**                     | `desktop`, Windows and Linux          |
| Desktop build and installers               | `apps/orbit/src-tauri`                                | `scripts/build-desktop.sh` | `desktop` (debug), `release` (signed) |

The desktop build needs Rust and the Tauri prerequisites; everything else needs only Bun.

## Web e2e (Playwright)

```sh
bunx playwright install chromium         # once, from packages/e2e
bun run e2e:web                          # = bun run --filter '@orbit/e2e' test:web
```

`packages/e2e/playwright.config.ts` starts two servers itself:

1. **Orion:** `bun packages/orion/src/main.ts --port 7718 --token e2e --mock-model --seed --data-dir <fresh temp dir>`, plus `ORION_SECRETS=file` (no OS keychain prompts), `ORION_MOCK_DELAY_MS=5` and `ORION_FAKE_CAMERAS=[]` (no real network probe). It is ready when `/health` responds.
2. **Vite:** the `@orbit/app` dev server on `127.0.0.1:5183`, with `VITE_ORION_URL=ws://127.0.0.1:7718/ws` and `VITE_ORION_TOKEN=e2e`.

These ports leave 7717 and 5173 free for your normal `bun run dev`. To change them, set
`ORBIT_E2E_ORION_PORT` and `ORBIT_E2E_VITE_PORT`. Every run gets a fresh seeded farm: 24 cattle,
4 horses, one wearable per tagged animal. Specs share that farm and run one at a time.

| Spec                 | What it proves                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `home.spec.ts`       | Home shows the seeded counts (`24 cattle · 4 horses`)                                                                                                                                                                                                                                                                                                                                                  |
| `herd.spec.ts`       | The herd table lists all 28 seeded animals. Sensor setup is not a built-in screen; device bindings retain the one-wearable rule in Orion and the data model.                                                                                                                                                                                                                                           |
| `local-ui.spec.ts`   | `build my orbit` runs the real `local_ui_build` (typecheck + `vite build --base ./`); `/` then hands off to `/app/e2e/` with the seeded counts, `/?safe` stays on the shipped UI, and Settings > Use original Orbit returns to it                                                                                                                                                                      |
| `pages.spec.ts`      | `make a page` writes a custom page that appears under "Your pages" and shows `24 cattle` read through `_orbit.js`                                                                                                                                                                                                                                                                                      |
| `farm-views.spec.ts` | The seeded farm has the catalog's ready-made views: Home shows a card each for Herd, Calendar and Camera wall and a card opens its page; the herd view filters to the 3 animals with alerts and opens an animal's panel; the calendar lists calvings, dry-offs and pregnancy checks worked out from the seeded inseminations; the camera wall shows pictures for online cameras (the relay is stubbed) |
| `chat.spec.ts`       | `list cows` streams an answer with a `done` `herd_query` tool card. `find cameras` runs `camera_discover` straight away (no approval prompt). A new session survives a page reload                                                                                                                                                                                                                     |

Tests wait on locators only; there are no fixed sleeps. On failure, the trace, screenshot and video
go to `packages/e2e/test-results`, and the HTML report goes to `packages/e2e/playwright-report`
(`bunx playwright show-report`).

## Desktop smoke (CI only)

`packages/e2e/desktop` follows https://v2.tauri.app/develop/tests/webdriver/. The CI `desktop`
job:

1. Compiles the Orion sidecar with `bun build --compile --target=<bun target>` into
   `apps/orbit/src-tauri/binaries/orion-<rustc host triple>[.exe]`.
2. Runs `tauri build --debug` (unsigned).
3. Uploads the bundles and the binaries as the `orbit-debug-<os>` artifact.
4. On Windows and Linux, installs `tauri-driver` and runs `bun run e2e:desktop`:
   - Windows uses an `msedgedriver` matching the runner's Edge, passed as
     `TAURI_NATIVE_DRIVER`.
   - Linux uses `webkit2gtk-driver` under `xvfb-run`.

   tauri-driver starts the app with `ORION_MOCK_MODEL=1 ORION_SEED=1`. The spec waits for Home
   to show the seeded counts served by the real sidecar, then opens Ask Orion and waits for the
   mock reply.

macOS has no WebDriver for WKWebView, so macOS gets a build and artifact only. Check it by hand
(next section).

Environment overrides:

- `ORBIT_APP_PATH`: the app binary. The default is
  `apps/orbit/src-tauri/target/debug/orbit-desktop[.exe]`.
- `TAURI_DRIVER_PATH`: the tauri-driver binary.
- `TAURI_NATIVE_DRIVER`: the native WebDriver (msedgedriver on Windows).

## Testing on Windows without owning Windows

1. **Use the CI artifacts.** Open the CI run, then `orbit-debug-windows-latest`, which holds the
   NSIS `.exe` and the `.msi` under `bundle/`. A green `desktop (windows-latest)` job already means
   the app launched, the sidecar started, seeded data rendered and chat replied.
2. **Try it by hand on a short-lived GCP Windows VM**, for example in project `agrointel-dd8f6`:

   ```sh
   gcloud compute instances create orbit-win-test --zone=europe-north1-a \
     --machine-type=e2-standard-4 --image-family=windows-2022 --image-project=windows-cloud \
     --boot-disk-size=60GB
   gcloud compute reset-windows-password orbit-win-test --zone=europe-north1-a --user=tester
   # Connect with Microsoft Remote Desktop (macOS) to the external IP, download the
   # artifact (gh run download, or a browser), install it, and test.
   gcloud compute instances delete orbit-win-test --zone=europe-north1-a --quiet   # when done
   ```

   Delete the VM the same day: Windows images bill a licence fee per hour. Allow RDP (tcp:3389)
   only from your own IP.
3. **Test a release candidate**: push a `v*` tag to create a draft release with signed
   installers, then install from the draft on the VM.

## CI workflows

`.github/workflows/ci.yml` runs on pushes to `main`, on pull requests and on manual dispatch.

- **`checks`** (ubuntu-latest, windows-latest, macos-latest) runs `bun install --frozen-lockfile`,
  `bunx biome ci .`, `bun run typecheck`, `bun run test`, the `@orbit/app` build, the workflow
  YAML check, Playwright Chromium and the web e2e suite. On failure it uploads the report.
- **`desktop`** (windows-latest, ubuntu-22.04, macos-latest; needs `checks`) installs Rust stable
  with the Swatinem cache, then runs the sidecar compile, `tauri build --debug`, the artifact
  upload and the tauri-driver smoke on Windows and Linux.

`.github/workflows/release.yml` runs on `v*` tags. It runs `tauri-apps/tauri-action` for
windows-x64, linux-x64, macos-arm64 and macos-x64. Each build gets the sidecar matching its
target, updater artifacts and `latest.json`, and goes into a **draft** GitHub release. A generated
`tauri.release.conf.json` turns on `createUpdaterArtifacts`, sets the updater pubkey, and on
Windows adds an Azure Trusted Signing `signCommand` when its secrets are set.

`bun run check:workflows` parses every workflow file (also run in CI).

## Secrets and variables

| Name                                                                                               | Kind                | Used by                                                                | Required                                         |
| -------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------- | ------------------------------------------------ |
| `TAURI_SIGNING_PRIVATE_KEY`                                                                        | secret              | release: signs updater bundles and `latest.json`                       | yes, for releases                                |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`                                                               | secret              | release                                                                | yes, if the key has a password                   |
| `TAURI_UPDATER_PUBKEY`                                                                             | repository variable | release: replaces the placeholder pubkey in `tauri.conf.json`          | yes, until the real key is committed             |
| `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`                                        | secrets             | release: Azure Trusted Signing service principal                       | optional (Windows signing is skipped when unset) |
| `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT`, `AZURE_TRUSTED_SIGNING_PROFILE` | secrets             | release: Trusted Signing endpoint URL, account and certificate profile | optional, together with the above                |
| `GITHUB_TOKEN`                                                                                     | built in            | release: creates the draft release                                     | automatic                                        |

Create the updater key pair once with `bunx tauri signer generate -w orbit.key`; this is a light
command and is fine to run locally. Store the private key as a secret and the public key as
`TAURI_UPDATER_PUBKEY`. Never commit either key file.
