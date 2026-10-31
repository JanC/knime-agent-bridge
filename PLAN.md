# Plan: one-click install for KNIME Agent Bridge

Status: draft for review. Nothing in this plan is implemented yet.
Baseline: v0.5.0 (`63358b4`), branch `bundle`.
Platform tags: **[mac]** macOS Apple Silicon dev machine, **[win]** Windows 11 machine, **[both]** must pass on both.

## 0. Goal and non-goals

Goal: a non-technical Windows 11 user installs the bridge with no terminal:

1. KNIME side: install a normal KNIME extension into their existing KNIME (update site or archive). No custom launcher, no private configuration.
2. AI side: double-click a `.mcpb` file to install the MCP server in Claude Desktop. Claude Desktop's bundled Node runs it, so no separate Node install.
3. Read-only by default. Write and execute operations need an explicit opt-in.

Non-goals for this plan: new MCP tools, Linux support, a KNIME Community Hub listing (tracked as a follow-up decision), and any change to how the bridge talks to KNIME internally.

## 1. Recon findings (from reading v0.5.0 on macOS)

These findings shape the milestones. Items marked "confirm" still need a KNIME install on the Mac (there is none yet).

### 1.1 Build and launch are Windows-only

| File | Windows assumption |
|---|---|
| `scripts/build.mjs` | `javac.exe`, `jar.exe`, default JDK `C:/Program Files/Java/jdk-24`, `LOCALAPPDATA` |
| `scripts/launch.mjs` | `knime.exe`, `LOCALAPPDATA`, clones `config.ini` and `bundles.info`, copies the whole `p2` dir |
| `scripts/register-codex.mjs` | Codex only |
| `Launch KNIME Agent.cmd` | Windows batch |
| `tests/native-*-probe.test.mjs`, `tests/native-operation-retention.test.mjs`, `tests/native-stage-telemetry.test.mjs` | Compile Java harnesses with `javac.exe` and `C:/Program Files/Java/jdk-24`, read `build/javac.args` |

### 1.2 Platform-specific runtime code

| Location | Issue | Proposed fix |
|---|---|---|
| `java/META-INF/MANIFEST.MF` | `Import-Package: com.sun.jna, com.sun.jna.platform.win32` is mandatory | Mark both `resolution:=optional`. The `com.sun.jna.platform` bundle is plain Java and normally exports `win32` on every OS, so it probably resolves on macOS already (confirm in M0). Optional import removes the risk either way. A Windows-only fragment is not needed for ~20 lines of code. |
| `NativeWorkflowExport.java:16,123-139` | `import com.sun.jna.platform.win32.*`, Kernel32 file ID, guarded by `os.name` | Move `windowsKey` into its own class `WindowsFileIdentity` that is only loaded on Windows. Keeps the class graph of `NativeWorkflowExport` free of JNA on macOS. macOS already gets `fileKey()` from the JDK (dev+inode), so no replacement is needed there. |
| `src/lifecycle.mjs:15` | Reads `/proc/<pid>/stat` on non-Windows; fails on macOS, so `creationIdentity` is `null` | Add a `darwin` branch using `ps -o lstart= -p <pid>` (or `sysctl kern.proc.pid` via `ps -o etime=`). Keep Linux on `/proc`. Fails test `server-lifecycle-v05`. |
| `src/lifecycle.mjs:12` | Spawns `powershell.exe` on Windows for process start time | Keep, but verify it works when Node is launched by Claude Desktop (execution policy, slow startup). Fallback: `wmic` is gone on recent Windows 11, so use `Get-CimInstance` only if `Get-Process` fails. |
| `src/canvas/render.mjs:99` | `chromium.launch({channel:'msedge'})` only | Try in order: `KNIME_AGENT_BROWSER` path, `msedge`, `chrome`, then any Chromium found by Playwright. If none, return the existing structured "renderer unavailable" omission. Fails 6 tests on macOS today. |
| `BridgeActivator.java:34-35`, `NativeWorkflowExport.java:41-42` | Runtime dir is `-Dknime.agent.runtime` or `~/.knime-agent/runtime` | Fine for the extension. Extract to one helper so both call sites agree. |
| `src/client.mjs:30` `defaultRuntimeDirectory()` | Default is `<package root>/runtime` | **Mismatch with Java.** Inside a `.mcpb` the package root is Claude Desktop's extension folder, so the server would look in the wrong place. Change default to `~/.knime-agent/runtime` (`os.homedir()`), keep `KNIME_AGENT_RUNTIME` and `--runtime` overrides. See decision D7 about the legacy launcher. |

### 1.3 KNIME API surface used (internal, version-sensitive)

Required bundles: `org.eclipse.core.runtime`, `org.eclipse.ui.workbench`, `org.eclipse.swt`, `org.knime.core`, `org.knime.core.util`, `org.knime.gateway.api`, `org.knime.gateway.impl`, `org.knime.gateway.impl.jsonrpc`, `org.knime.gateway.json`, `com.github.briandilley.jsonrpc4j`, `org.knime.ui.java`, Jackson (core, databind, annotations). Imports: `org.apache.commons.lang3.function`, JNA.

Most fragile surfaces (break first on a KNIME bump):

- `org.knime.ui.java.api.DesktopAPI` (readiness via `areDependenciesInjected`, desktop functions)
- `org.knime.gateway.impl.project.ProjectManager`, `org.knime.gateway.impl.webui.jsonrpc.*` (gateway dispatch)
- `org.knime.core.node.workflow.WorkflowExporter`, `SingleNodeContainer.getModelSettingsUsingFlowObjectStack`
- `com.equo.chromium` bundle looked up reflectively in `EditorViewportCapture`
- SWT shell inspection in `DesktopDialogs` (dialog text differs per OS; see M2)

M0 produces a full list (class plus method) as `docs/KNIME_API_SURFACE.md`, which becomes the checklist for every version bump.

### 1.4 Activation

Today the launcher writes the bundle into `bundles.info` with start level 4 and `autostart=true`. A p2-installed bundle is not started automatically, and the manifest has no `Bundle-ActivationPolicy`. The extension needs `p2.inf` touchpoint instructions (`markStarted(started:true)`, `setStartLevel(startLevel:4)`) so it starts on its own after restart. The activator also fingerprints its own JAR and requires a regular file, so the bundle must install as a JAR, not unpacked.

### 1.5 Write classification already exists

`OperationPolicy.READS` and `GATEWAY_READS` in Java already split reads from mutations, and `BridgeActivator.process` already calls `OperationPolicy.mutation(...)`. Read-only mode can reuse this as the single source of truth. Three MCP tools (`knime_core_call`, `knime_gateway_call`, `knime_desktop_call`) carry both reads and writes, so the gate must be per operation, not per tool.

### 1.6 License

The repo has no `LICENSE` file. **This blocks redistribution** of the update site, the `.mcpb` and any Hub listing. KNIME Analytics Platform is GPLv3 with KNIME's additional permissions; the bridge links internal KNIME APIs (not just node extension points), so the license choice needs care. See decision D1.

### 1.7 Namespace

The bundle symbolic name `org.knime.agent.bridge` and Java package `org.knime.agent` use KNIME's namespace, while the README says it is not an official KNIME product. In an Install Extensions dialog this looks like a KNIME-published extension, could collide with a future KNIME bundle, and would likely be rejected for a Community Hub listing. See decision D2.

### 1.8 Node test baseline on macOS

`npm ci && npm test` on macOS (Node 26.10, JDK 21): 245 tests, 195 pass, **29 fail**, 21 skipped. Causes:

| Count | Cause |
|---|---|
| 6 | Edge not installed (`channel: 'msedge'`) |
| ~5 | `process.env.LOCALAPPDATA` undefined in `path.join` (launcher tests, harness compile) |
| 4+ | Tests that need a live KNIME fail with `NO_LIVE_SESSION` instead of skipping |
| 3 | `build/javac.args` missing (Java harness tests depend on a prior Windows build) |
| 2 | Telemetry seeding tests (path layout) |
| 1 | `/proc` in `lifecycle.mjs` |
| rest | Downstream of the above (missing built JAR, path-lineage harness) |

## 2. Target architecture

```
knime-agent-bridge/
  pom.xml                       Tycho reactor (new)
  knime-5.12.target             target platform (new)
  bundles/<bundle-id>/          moved from java/ (MANIFEST.MF, build.properties, plugin.xml, p2.inf, src/)
  features/<feature-id>/        feature.xml (new)
  releng/update-site/           eclipse-repository, category.xml (new)
  java-tests/                   harnesses + stubs from tests/java, compiled by Maven (new location)
  packaging/mcpb/               manifest.json, icon, build script input (new)
  scripts/build-mcpb.mjs        cross-platform .mcpb build (new)
  src/, tests/                  Node server, CLI, tests (existing)
  scripts/launch.mjs            kept as developer/legacy path (D7)
```

Runtime contract after the change:

- Runtime dir: `~/.knime-agent/runtime` on both sides. Overrides: `-Dknime.agent.runtime` (Java), `KNIME_AGENT_RUNTIME` / `--runtime` (Node). Unchanged file layout under `sessions/<uuid>/`.
- IPC protocol: unchanged. One additive field in `session.json`: `writePolicy: {enabled: bool, source: "preference"|"system-property", readOperations: [...], gatewayReadMethods: [...]}`.
- MCP tool contracts: unchanged names and schemas. One additive error code `WRITES_DISABLED` with `nativeDispatch: "not_started"` and a `suggestedReadOnlyNextCall`. This is the only contract change and is required by goal 3.

### Read-only design (D4, D5 decided)

**Update 2026-10-31 (D4 changed):** writes are on by default. Everything below still applies when the user turns the preference off; only the defaults flipped.

Read-only means exactly the operations in `OperationPolicy.READS` plus `gateway.call` methods in `GATEWAY_READS` (D5). Everything else is a write, including `desktop.openProject`, `desktop.saveProject`, `desktop.closeProject`, `desktop.dialogAction`, file exports (`core.port.export`, `core.workflow.export`) and any unknown operation. In read-only mode the agent can only inspect workflows the user already has open.

Two layers, both default off:

1. **Java (authoritative).** A KNIME preference page "Agent Bridge" under the KNIME category with one checkbox: "Allow AI agents to modify, execute and save workflows". Stored in instance scope `<bundle-id>/allowWrites`. In `BridgeActivator.process`, if `OperationPolicy.mutation(op,args)` and writes are off, fail with `WRITES_DISABLED` before acceptance (no receipt, `nativeDispatch: not_started`). System property `-Dknime.agent.allowWrites=true` overrides for tests and for the legacy launcher, so v0.5 developer behavior is unchanged. This protects against every client (Claude, Codex, CLI), not only Claude Desktop.
2. **Node (advisory, fast feedback).** `.mcpb` user setting "Allow write operations" maps to `KNIME_AGENT_ALLOW_WRITES`. When off, the server refuses mutation operations locally using the `writePolicy` lists from `session.json` (so the classification never drifts from Java), and tool descriptions say so. Tools stay listed so the agent can explain how to enable writes.

A write runs only if both switches are on. `health` and `knime_connection` report both states.

## 3. Milestones

Each milestone has an exit gate; do not start the next one on the same OS until it passes.

---

### M0 Recon and decisions [mac]

Progress 2026-10-31: tasks 1 to 4 done, see `docs/PLATFORM_NOTES.md`. KNIME 5.12.0 at `/Applications/KNIME 5.12.0.app`, same KNIME build as the Windows v0.5 verification. JNA `win32` resolves on macOS. Used internal packages are not `x-internal`. Tycho target candidate: `https://update.knime.com/analytics-platform/lts/5.12`. KNIME trusts only `update.knime.com` for p2 content, so our site will trigger a trust prompt (feeds D8). All decisions made. API surface doc and LICENSE done. Task 5 (Claude Desktop Node version) moved to the start of M4: Claude Desktop 4.29.0 on Electron 44.9.3, check with a probe `.mcpb`.

API surface findings (`docs/KNIME_API_SURFACE.md`): 19 bundles, 159 classes, 459 members. Bridge sources compile on macOS against KNIME 5.12.0. Two bundles are used but only reached through another bundle's re-export (`org.eclipse.equinox.common`, `org.knime.shared.workflow.def`); declare them in M1. 18 reflective call sites, including `setAccessible` calls into non-public `NodeModel`, `NodeContainer` and `SingleNodeContainer` methods in `SettingsHealth`, plus `GenerateSVGWorkflowSaveHook.renderPreviewSVG` and `com.equo.chromium.ChromiumBrowser`. These are the first things to check on every KNIME bump.

**Changes**

- `docs/KNIME_API_SURFACE.md`: every KNIME/Eclipse class and method used, grouped by bundle, with a "fragility" note. Generated with a small script (`scripts/api-surface.mjs`) that runs `javap`/`jdeps` over the compiled classes so it can be re-run on each bump.
- `docs/PLATFORM_NOTES.md`: confirmed macOS KNIME layout.
- `LICENSE` with the GPL-3.0 text (D1), plus a license line in `README.md`.

**Tasks**

1. Install KNIME 5.12 (exact build used on Windows, from `docs/VERIFICATION-0.5.md`) on the Mac. Record: app path (expected `/Applications/KNIME 5.12.x.app`), `Contents/Eclipse/knime.ini`, `Contents/Eclipse/plugins`, `Contents/MacOS/knime`, where p2 installs extensions (inside the `.app` or in a user area), and whether installing an extension breaks the app's code signature or triggers Gatekeeper.
2. Check that `com.sun.jna.platform` exists in KNIME 5.12 macOS `plugins/` and exports `com.sun.jna.platform.win32`.
3. Confirm KNIME's public p2 URL for 5.12 and any third-party site it needs (for the Tycho target).
4. Check which required packages are `x-internal` or `x-friends` (Tycho compiles these as warnings or errors).
5. Confirm the Node version Claude Desktop bundles on macOS and Windows (must satisfy `>=22`; `package.json` says `engines.node >=22`).
6. Collect decisions D1 to D12.

**Acceptance [mac]**

- [x] `docs/KNIME_API_SURFACE.md` lists every `org.knime.*`, `org.eclipse.*`, `com.equo.*` reference and matches `grep` of `java/src`. Generated by `scripts/api-surface.mjs` (also writes `docs/knime-api-surface.json` for diffing); all 58 KNIME/Eclipse imports in `java/src` covered; reflective uses listed separately. Unit tests: `tests/api-surface.test.mjs`.
- [ ] macOS KNIME paths recorded with screenshots of the About and Installation Details dialogs. Paths recorded in `docs/PLATFORM_NOTES.md`; screenshots need you to open KNIME (move to M2 if not done before).
- [x] JNA question answered with evidence (bundle file name and its `Export-Package`). See `docs/PLATFORM_NOTES.md`.
- [x] `LICENSE` (GPL-3.0) committed, text taken from the copy shipped in KNIME's `org.knime.core` (SHA-256 `8ceb4b9e…`, the standard `COPYING`). `package.json` declares `GPL-3.0-only`.
- [x] Decisions D1 to D12 answered (2026-10-31).

**Risks / open questions**: KNIME may not publish a stable per-release p2 URL that contains `org.knime.ui.java` and the gateway bundles. Fallback is a Tycho "Directory" target location pointing at an installed KNIME's `plugins/` folder (works on both OSes, but CI must download KNIME).

---

### M1 Cross-platform build [both]

**Changes**

- New `pom.xml` (Tycho reactor), `knime-5.12.target`, `.mvn/extensions.xml`. Pin the Tycho version (choose the current stable at M1 start; record it).
- Move `java/` to `bundles/<bundle-id>/` with `build.properties`. Manifest changes:
  - `Bundle-Version: 0.6.0.qualifier`
  - New `Bundle-SymbolicName` per D2.
  - Declare `org.eclipse.equinox.common` and `org.knime.shared.workflow.def` explicitly (today they resolve only via re-export; see `docs/KNIME_API_SURFACE.md`).
  - Version ranges on KNIME bundles per D3, e.g. `org.knime.core;bundle-version="[5.12.0,6.0.0)"`.
  - `Import-Package: com.sun.jna;resolution:=optional, com.sun.jna.platform.win32;resolution:=optional`.
- Extract `WindowsFileIdentity.java` from `NativeWorkflowExport`. Extract `RuntimeDirectory.java` used by `BridgeActivator` and `NativeWorkflowExport`.
- `BridgeActivator.VERSION`: read from `context.getBundle().getVersion()` instead of the hardcoded `"0.5.0"`.
- Reproducible JAR: fixed `project.build.outputTimestamp`, qualifier from git commit time. The bundle fingerprint stays meaningful for named profiles.
- Move `tests/java/*` harnesses into `java-tests/` built by Maven (plain `javac` via `maven-compiler-plugin` with the stub source sets). Node tests that compile harnesses switch from `javac.exe` to the Maven-built classes, or to `path.join(JAVA_HOME,'bin', process.platform==='win32'?'javac.exe':'javac')` as an interim.
- `scripts/build.mjs`: keep as a thin fallback (`--legacy`), fix `javac`/`jar` names per platform and resolve the JDK from `JAVA_HOME`. Document that Tycho is the release build.
- Node fixes so the suite is green on macOS:
  - `src/lifecycle.mjs`: darwin branch.
  - `src/canvas/render.mjs`: browser fallback chain.
  - `src/client.mjs`: default runtime `~/.knime-agent/runtime` (behind D7).
  - Tests that need live KNIME: skip unless `KNIME_AGENT_LIVE=1` (single gate env var, documented). They must report SKIP, not FAIL.
  - Launcher tests: inject `KNIME_HOME` in the test env instead of relying on `LOCALAPPDATA`.
- `package.json`: `test:unit` (no KNIME, no browser), `test:live` (needs KNIME), keep `test`.

**Progress 2026-10-31 [mac]** (commit `77fd786`). Done as planned, with these differences:

- Tycho 5.0.4. Target is `releng/target/knime-5.12.target` against `https://update.knime.com/analytics-platform/lts/5.12/5.12.0` in `planner` mode (`slicer` does not follow dependencies). Every required bundle, Eclipse included, comes from that one site. No `.mvn/extensions.xml` (plain `pom.xml`).
- Bundle ID `io.github.juniper234.knime.agentbridge` (D2, matches the git remote). Java package stays `org.knime.agent`.
- Java harnesses were **not** moved into a Maven module. Instead `scripts/lib/java-toolchain.mjs` finds the JDK and KNIME on both OSes, and the Node tests use it. Same coverage, much less churn.
- No `test:unit` / `test:live` scripts. `npm test` runs what the machine supports; `tests/helpers/requirements.mjs` skips the rest with a reason (needs JDK, KNIME, dev build, `KNIME_AGENT_LIVE=1`, or Windows).
- `scripts/build.mjs` stays the developer build (no `--legacy` flag); it stamps the qualifier as `dev<source hash>` and `launch.mjs` writes the matching version into `bundles.info`.
- Fixed a v0.5 bug found on the way: the stage telemetry harness could not compile (stubs for `Platform`, `FileLocator` missing).
- `package.json` and the bundle are 0.6.0.

**Acceptance**

- [x] [mac] `mvn -B verify` builds the bundle with only JDK 21 and Maven (no KNIME install used). About 30 s cold, 6 s warm.
- [ ] [win] Same on Windows.
- [x] [mac] Two clean builds of the same commit produce byte-identical bundle JARs (SHA-256 `a0cb06ca…` for `77fd786`); qualifier `0.6.0.202610311128` = commit time in UTC.
- [ ] [win] Windows build of the same commit has the same SHA-256 as the Mac build.
- [x] [both] Built JAR manifest shows optional JNA imports and the chosen version ranges.
- [x] [mac] `npm ci && npm test`: 255 tests, 225 pass, 0 fail, 30 skipped (8 live KNIME, 1 Windows-only, rest env-gated v0.4/v0.5 cohorts). Without KNIME and `build/`: 218 pass, 0 fail, 37 skipped.
- [ ] [win] `npm test` on Windows 11 with Edge: 0 failures. Also `node scripts/build.mjs` then `npm test` so the probe tests run.
- [x] [mac] Canvas render tests pass with Chrome and no Edge (`src/canvas/browser.mjs`, `tests/canvas-browser.test.mjs`).
- [x] [mac] Lifecycle test reports a non-null `creationIdentity` with source `darwin_ps_lstart`.
- [x] [mac] Java harness tests (`ContextRegistryHarness`, `PathLineageHarness`, stage telemetry, operation retention, workflow export, dialog probe) run and pass on macOS via the shared toolchain.

**To run on Windows** (in a clone of this branch, JDK 21 and Maven installed):

```
mvn -B verify
certutil -hashfile bundles\io.github.juniper234.knime.agentbridge\target\io.github.juniper234.knime.agentbridge-0.6.0-SNAPSHOT.jar SHA256
npm ci
node scripts/build.mjs
npm test
```

**Risks** (R3 resolved on macOS: no access errors, only an encoding warning, now fixed): Tycho may reject access to internal packages that plain `javac` accepted (plain `javac` ignores OSGi visibility). If so, add `x-friends`-aware compiler settings or `Eclipse-ExtensibleAPI`-free workarounds; worst case keep the legacy classpath build for compilation and use Tycho only for feature/site packaging.

---

### M2 Bundle loads on macOS [mac]

Use the existing launcher path (adapted for macOS) to isolate "does the code run on macOS" from "does p2 install work" (M3).

**Changes**

- `scripts/launch.mjs`: macOS support. Resolve `KNIME_HOME` to `.../KNIME 5.12.x.app/Contents/Eclipse`, executable `../MacOS/knime`, `knime.ini` from `Contents/Eclipse`. Pass `-Dknime.agent.allowWrites=true` so developer behavior matches v0.5.
- `docs/PLATFORM_NOTES.md`: macOS launch notes (`-XstartOnFirstThread` comes from `knime.ini`, keep it).

**Acceptance [mac]**

- [x] `node scripts/launch.mjs --workspace runtime/workspace` starts KNIME; the bridge activates (no errors in `runtime/knime.log` for the bundle).
- [x] `node src/cli.mjs sessions` lists one session with `status: ready`, `modernUiReady: true`, `knimeVersion` 5.12.x.
- [x] `node src/cli.mjs health` succeeds; `bundleFingerprint` equals the SHA-256 of the built JAR.
- [x] `desktop.uiState` returns readable shell info on macOS (SWT Cocoa); note any differences in `PLATFORM_NOTES.md`.
- [x] `core.workflow.export` on a saved synthetic workflow succeeds on macOS (exercises the non-JNA identity path).
- [x] `KNIME_AGENT_LIVE=1 npm run test:live` against the synthetic workspace: record pass/fail per test in `docs/VERIFICATION-mac.md`. Failures are triaged, not necessarily fixed here (Windows remains the release target).

**Progress (2026-10-31)**: done on macOS. All 32 live tests pass (there is no `test:live` script; the files and gates are listed in `docs/VERIFICATION-mac.md`). Modern UI was ready about 6 s after launch, native SVG preview and the Equo Chromium viewport capture both work on Cocoa, and workflow export works without JNA. The launcher also passes `-Dknime.agent.allowWrites=true`, which the bridge ignores until M5.

**Risks**: modern UI readiness on macOS (Equo Chromium) may differ; viewport capture (`EditorViewportCapture`) may not work on Cocoa. Acceptable as a documented gap on macOS if Windows works.

---

### M3 KNIME extension [mac, then win]

**Changes**

- `bundles/<bundle-id>/p2.inf`: `instructions.configure` with `markStarted(started:true)` and `setStartLevel(startLevel:4)`; matching `instructions.unconfigure`.
- `bundles/<bundle-id>/plugin.xml`: preference page (`org.eclipse.ui.preferencePages`, category = KNIME's root page ID confirmed in M0) and preference initializer. Writes default to off.
- `BridgeActivator`: read the preference on each dispatch (cheap); add `WRITES_DISABLED`; publish `writePolicy` in `session.json`.
- `features/<feature-id>/feature.xml`: name, provider, license text (D1), description, `requires` on the KNIME feature range.
- `releng/update-site/category.xml`, `pom.xml` module: produces `target/repository/` and a zipped archive `<name>-update-site-<version>.zip`. The zip is the only distribution format (D6); no hosted site.
- No signing (D8). Users will see p2's unsigned-content prompt; `INSTALL.md` shows it.

**Acceptance**

Install path for each OS is: KNIME > Preferences > Install/Update > Available Software Sites > Add > Archive (the zip), then File > Install KNIME Extensions.

- [ ] [mac] Fresh KNIME 5.12 (new app copy, new workspace, no launcher). Install from the zipped site. Dialog shows the extension under the chosen category with the right name, version and license.
- [ ] [mac] After the restart prompt, with no other action, `node src/cli.mjs sessions` shows a ready session in `~/.knime-agent/runtime`.
- [ ] [mac] Preferences > KNIME > Agent Bridge exists; checkbox is off. `health` shows `writePolicy.enabled: false`.
- [ ] [mac] With writes off, `knime_core_call core.settings.patch` returns `WRITES_DISABLED` with `nativeDispatch: not_started`, and the workflow is unchanged (inspect snapshot before/after).
- [ ] [mac] With writes off, `desktop.openProject` and `core.workflow.export` are also refused (D5); `core.snapshot`, `core.table.read` and `gateway.call WorkflowService.getWorkflow` succeed.
- [ ] [mac] Turn the checkbox on (no restart). The same patch succeeds. Turn off again: refused again.
- [ ] [mac] Uninstall via About > Installation Details > Uninstall. After restart: no session appears, the bundle is gone from the profile (`plugins/` and p2 profile checked), KNIME starts with no errors. Reinstall works.
- [ ] [mac] Install into a KNIME of an unsupported version (e.g. previous release): behavior matches D3 (either install refused with a clear p2 message, or installs and reports `unsupported` in read-only).
- [ ] [win] Repeat all of the above on Windows 11 with KNIME installed by the official installer into the default per-user location.
- [ ] [win] Repeat install with KNIME in `C:\Program Files\KNIME` (admin install). Record whether elevation is needed.
- [ ] Automated [both]: `mvn verify` includes a p2 metadata check (feature installable unit present, `p2.inf` instructions in `content.xml`).

**Progress (2026-10-31, mac)**: built and dry-run. `mvn -B verify` now produces `releng/update-site/target/knime-agent-bridge-update-site-0.6.0.zip` (feature `io.github.juniper234.knime.agentbridge.feature`, category "KNIME Agent Bridge (community)", GPL-3.0 license text, `markStarted` in `p2.inf`). Installed into an APFS clone of KNIME 5.12.0 with the p2 director: the bundle is registered with `start=true`, KNIME started the bridge with no launcher, the session appeared in `~/.knime-agent/runtime` with `writePolicy.enabled: true, source: preference`, and a read plus a workflow creation succeeded. Director uninstall removed it from `bundles.info` (the JAR stays in `plugins/` until p2 cleanup). The Java gate is covered by the stage harness: with writes off, `core.reset` returns `WRITES_DISABLED` with `nativeDispatch: not_started`, no receipt and no worker task. Still open: the Install Extensions dialog by hand, the preference page in the UI and its live toggle, and the unsupported-version check. Install guide: `docs/INSTALL.md`.

**Risks**: p2 "unsigned content" warning confuses non-technical users (no signing per D8; mitigate with the install guide). KNIME updates may be blocked by a strict version range (D3). Installing into a signed macOS `.app` may break its signature.

---

### M4 MCP server as `.mcpb` [mac, then win]

**Changes**

- `packaging/mcpb/manifest.json` (MCPB manifest, version set at M4 start, check against `mcpb validate`):
  - `server.type: "node"`, `entry_point: "server/src/server.mjs"`, `mcp_config.command: "node"`, args `["${__dirname}/server/src/server.mjs", "--runtime", "${user_config.runtime_dir}"]`.
  - `env`: `KNIME_AGENT_ALLOW_WRITES=${user_config.allow_writes}`, `KNIME_AGENT_CANVAS=${user_config.enable_canvas}`, `KNIME_AGENT_BROWSER=${user_config.browser_path}`.
  - `user_config`: `allow_writes` (boolean, default false), `enable_canvas` (boolean, default false per D10), `runtime_dir` (directory, default `${HOME}/.knime-agent/runtime`), `browser_path` (file, optional).
  - `compatibility.platforms: ["win32","darwin"]`, `compatibility.runtimes.node: ">=22"`.
  - `tools`: the 25 tool names and one-line descriptions, generated from `src/catalog.mjs` + `src/v02-tools.mjs` by the build script so it cannot drift.
  - `license`, `author`, `repository`, `icon`.
- `scripts/build-mcpb.mjs`: stage `package.json`, `package-lock.json`, `src/`, `npm ci --omit=dev` into `build/mcpb/server`, copy manifest, run `npx @anthropic-ai/mcpb@<pinned> pack`. Cross-platform Node only.
- `src/access-policy.mjs` (new): Node-side write gate using `writePolicy` from the selected session's `session.json`; fallback list mirrors `OperationPolicy` only when the field is missing (older bundle) and then treats unknown operations as writes.
- `src/catalog.mjs`: call the gate in `dispatchTool` for `knime_core_call`, `knime_gateway_call`, `knime_desktop_call`, `knime_layout_apply`, `knime_verify_workflow` (if it mutates; confirm in M4), returning `WRITES_DISABLED`.
- `src/canvas/render.mjs`: honor `KNIME_AGENT_CANVAS=false` by returning a structured "disabled by setting" omission without loading Playwright.
- `src/server.mjs` instructions: mention read-only state and how the user enables writes (both switches).
- Client registration (D9: Codex and Claude). Claude Desktop uses the `.mcpb`. Keep `scripts/register-codex.mjs` and add `scripts/register-claude-code.mjs` (same pattern, `claude mcp add`), both pointing at `~/.knime-agent/runtime` and passing `KNIME_AGENT_ALLOW_WRITES` explicitly. These are for developers; non-technical users only use the `.mcpb`.
- Playwright: ship `playwright-core` only (no browser download). Size budget for the `.mcpb`: under 15 MB; record actual size.

**Acceptance**

- [ ] [mac] `node scripts/build-mcpb.mjs` produces `artifacts/knime-agent-bridge-<version>.mcpb`; `mcpb validate` passes.
- [ ] [mac] Double-click the file with Claude Desktop installed and no Homebrew Node on `PATH` (temporarily rename it, or test under a second macOS user). Install dialog shows name, description, settings; writes off by default.
- [ ] [mac] In a new chat, Claude lists the 25 tools. "List KNIME sessions and check health" works against the M3-installed extension.
- [ ] [mac] Read operations work: `knime_workflow`, `knime_settings`, `knime_table`, `knime_nodes`.
- [ ] [mac] Ask Claude to change a node setting: refused with `WRITES_DISABLED`, and the reply tells the user which settings to enable. Workflow unchanged.
- [ ] [mac] Enable `allow_writes` in Claude Desktop only: still refused by KNIME (Java gate). Enable the KNIME preference too: write succeeds.
- [ ] [mac] Canvas off: `knime_canvas_view` returns the disabled omission, no browser process starts. Canvas on with Chrome: image returned.
- [ ] [mac] Disable and remove the extension in Claude Desktop: no leftover Node process; `~/.knime-agent/runtime` untouched.
- [ ] [both] `register-codex.mjs` and `register-claude-code.mjs` register the server; a fresh Codex chat and a fresh Claude Code session each list the tools and get `WRITES_DISABLED` on a write by default.
- [ ] [win] Repeat on Windows 11 with no Node.js installed at all (check `where node` fails).
- [ ] Automated [both]: unit tests for `access-policy.mjs` (every operation in `OperationPolicy.READS` allowed, every core/desktop/gateway write refused, unknown gateway method refused); test that the generated manifest tool list equals `toolCatalog` names; MCP stdio test that runs the staged `build/mcpb/server` with `KNIME_AGENT_ALLOW_WRITES=false`.

**Progress (2026-10-31, mac)**: `npm run build:mcpb` produces `artifacts/knime-agent-bridge-0.6.0.mcpb` (5.9 MB packed, 21 MB unpacked, 2296 files) with the pinned `@anthropic-ai/mcpb` 2.1.2; `mcpb validate` passes and the manifest's tool list is generated from `toolCatalog` (25 tools). The server unpacked from the bundle lists 25 tools, reads health from the M3-installed extension and refuses a write with `WRITES_DISABLED` (`nativeDispatch: not_started`) when `KNIME_AGENT_ALLOW_WRITES=false`. Changes from the plan: the client gate lives in `BridgeClient.call` (covers every tool, including layout apply), `allow_writes` defaults to on (D4 changed), there is no `runtime_dir` setting (the server default `~/.knime-agent/runtime` matches the extension), and the entry point is `src/server.mjs` at the bundle root. MCP SDK updated to 1.32.2 for published advisories; zod 3 still has a memory-exhaustion advisory whose fix is the breaking zod 4 (R17). The user installed it by double-click in Claude Desktop and it works; Claude Desktop runs it with its built-in Node.js (exact version not logged), so R-Node is resolved for macOS. Still open: the Claude Desktop toggles exercised one by one, Windows.

**Risks**: Claude Desktop's bundled Node version may be below 22 (check in M0). `powershell.exe` spawn from `lifecycle.mjs` may be slow or blocked under Claude Desktop on locked-down Windows; the code already degrades to `creationIdentity: null`, so verify that path.

---

### M5 Functional pass [mac]

Run with the M3 extension and M4 `.mcpb`, both write switches on, against a synthetic workspace only (per `AGENTS.md`), never coursework.

**Changes**

- `tests/fixtures/sample-workflow/` creation script (synthetic Table Creator > Column Filter > Row Filter or similar, created through the bridge itself).
- `scripts/verify-install.mjs`: scripted version of the checklist below via the CLI, writing `docs/measurements/install-<os>-<version>.json`.
- `docs/VERIFICATION-0.6.md`: exact KNIME build, OS, verified operations, untested gaps.

**Progress (2026-10-31)**: `scripts/verify-install.mjs` passed 11 of 11 steps against the installed extension in a second KNIME window on `runtime/workspace-m5`, pinned to that session. The synthetic workflow is created by the script itself, so no separate `tests/fixtures/sample-workflow/` was needed. Results are in `docs/VERIFICATION-0.6.md` and `docs/measurements/install-darwin-0.6.0.json`.

**Acceptance [mac]**

Run by the script through MCP. A by-hand run from Claude Desktop is still open.

- [x] Inspect: list sessions, bind a context, read the workflow snapshot, read settings of one node.
- [x] Edit settings: preview then apply a typed settings change; `settingsValidation` clean; snapshot shows the new value.
- [x] Execute: execute the workflow; `knime_wait` until executed; node messages empty.
- [~] Read a table: `knime_table` page and `knime_table_verify` with expected row count. The constant column was not checked because the fixture has none.
- [x] Save: save the project; `knime_wait` clean-save; close and reopen in KNIME; the setting persists (checked via `knime_settings` after reopen).
- [x] Canvas: one `knime_canvas_view` overview image, reviewed.
- [~] Repo scripts: `npm run test:adapter` (49/49) and `npm test` (240 pass, 30 live skips). The live test files and `test:beta` were not run against the installed extension because they do not pin a session yet.
- [x] Functional, visual and persistence evidence listed separately in `docs/VERIFICATION-0.6.md`.
- [ ] Same flow by hand from Claude Desktop, including the three `.mcpb` settings.

**Risks**: `test:beta` and `verify-lifecycle-v05.mjs` may assume the launcher. Adapt them to attach to an already running KNIME (explicit `--session`).

---

### M6 Windows acceptance [win]

Done as a non-technical user would, on a clean Windows 11 user account (or a fresh VM snapshot) with only KNIME and Claude Desktop installed. No Node, no JDK, no Git.

**Acceptance [win]**

- [ ] Follow only `docs/INSTALL.md` (from M7 draft). Time each step; note every dialog with a screenshot.
- [ ] Download the update-site zip and `.mcpb` with Edge. Record SmartScreen / Mark-of-the-Web prompts for each.
- [ ] Record Defender behavior (real-time scan of the zip, the JAR, Node child processes). No quarantine.
- [ ] KNIME install of the extension, restart, preference page present, writes on (D4 default).
- [ ] `.mcpb` install by double-click; tools listed; with Allow changes off, a change is refused.
- [ ] Enable writes in both places; M5 checklist passes on Windows.
- [ ] `core.workflow.export` exercises the Kernel32 file identity path (`WindowsFileIdentity`) and returns a manifest; the JNA import resolves.
- [ ] Canvas with Edge (default on Windows) returns images; with canvas disabled, no Edge process starts.
- [ ] Paths with spaces and non-ASCII: Windows user name with a space (e.g. `Jane Doe`), workspace under `C:\Users\Jane Doe\KNIME workspace\`, KNIME under `C:\Program Files\KNIME`. Sessions, IPC, export and save all work.
- [ ] OneDrive-redirected Documents folder as workspace: works or is documented as unsupported.
- [ ] Uninstall both parts; nothing left running; KNIME still starts.
- [ ] Every unsigned-content, SmartScreen and Defender prompt captured as a screenshot for `INSTALL.md` (no signing per D8).

**Risks**: per-user vs admin KNIME install changes whether extension install needs elevation. Corporate Defender or AppLocker policies can block Node child processes started by Claude Desktop; document, do not work around.

---

### M7 Release [both]

**Changes**

- `.github/workflows/build.yml`: matrix `macos-14` (arm64) and `windows-2022`. Steps: `mvn -B verify`, `npm ci`, `npm run test:unit`, `node scripts/build-mcpb.mjs`. Upload update-site zip, `.mcpb`, SHA-256 files as artifacts. Fail if the two OS builds produce different bundle JAR hashes.
- `.github/workflows/release.yml`: on tag `v*`, build the update-site zip, `.mcpb` and SHA-256 files and keep them as workflow artifacts. No publishing and no signing (D6, D8); you ship the files yourself.
- `.github/workflows/knime-compat.yml`: scheduled weekly and manual. Rebuild against the newest KNIME target (compile-level check) and run `scripts/api-surface.mjs` diff. Opens an issue on failure. See policy below.
- `docs/INSTALL.md`: one page, screenshots for Windows (primary) and macOS, written for non-technical users. Covers: adding the zip as an archive site, the unsigned-content prompt, install, restart, Claude Desktop double-click, enabling writes, updating to a newer zip, uninstall. Short developer section for Codex and Claude Code registration.
- `docs/COMPATIBILITY.md`: table of bridge version x KNIME version x OS x verification status (verified, compile-only, unsupported) with links to verification receipts.
- `README.md`: new "Install" section pointing at `docs/INSTALL.md`; current launcher steps move to "Developer setup".
- `docs/VERIFICATION.md`: exact supported builds, verified operations, untested gaps (required by `AGENTS.md` before a release claim).
- `scripts/package.py`: either removed or kept for the developer source zip (D7).

**Acceptance**

- [ ] [both] CI green on both runners from a clean tag; artifacts downloadable.
- [ ] [both] Bundle JAR SHA-256 identical across the two runners.
- [ ] [mac] Install the CI-built update-site zip (not a local build) into fresh KNIME.
- [ ] [win] Same on Windows; then upgrade from the previous bridge version by adding the newer zip and installing it over the old one. The old version is replaced, not duplicated.
- [ ] [win] A second person (or you, following only `INSTALL.md` on a clean account) completes install in under 15 minutes without a terminal.
- [ ] `COMPATIBILITY.md` lists only builds with a verification receipt as "verified".

---

### Added in 0.6: canvas selection [mac verified]

`knime_selection` (MCP) and `desktop.selection` (native, read-only) return the nodes, annotations and connections selected on the active workflow tab, with node names, factories, states and native IDs. KNIME keeps canvas selection only in its browser UI, so `SelectionAccess` runs one constant script through `ChromiumBrowser.executeJavaScript` and reads the result back from session storage under a one-off key; no agent input reaches the script. Verified on macOS against KNIME 5.12.0 (`org.knime.ui.java 5.12.0.v202606150722`): empty selection, two nodes selected through the store, one node selected by a real mouse click, no leftover storage keys, about 0.17 s per CLI call. Not yet verified on Windows or inside components/metanodes.

## 4. KNIME version policy

Decided (D3):

1. **Declared range**: manifest/feature require `[5.12.0, 6.0.0)` so a KNIME update never gets blocked by the bridge.
2. **Runtime gate**: the activator holds a list of verified KNIME minor versions (built from `COMPATIBILITY.md` at build time). On a version not in the list, the bridge starts but forces read-only, sets `health.compatibility: "unverified"`, and says so in `health` and the KNIME preference page. Writes on an unverified version need a second explicit setting ("allow on unverified KNIME versions").
3. **Linkage safety**: wrap native dispatch so `LinkageError` (`NoSuchMethodError`, `NoClassDefFoundError`) becomes `UNSUPPORTED_KNIME_API` with the missing symbol, instead of a crash or a hung request.
   Existing exact pin: `NativePreviewCapture.BUNDLE_VERSION` requires `org.knime.gateway.impl 5.12.0.v202606171738` exactly, so native canvas previews switch off on any other KNIME build, including a 5.12.x service release. Move it into the same verified-versions list.
4. **Testing a new KNIME release** (each ~6 weeks):
   - Within 1 week: `knime-compat.yml` compiles against the new target and diffs the API surface. [CI, both]
   - Rerun `node scripts/api-surface.mjs --knime <new install>` and diff `docs/knime-api-surface.json`; check every row of its reflective table by hand. [mac or win]
   - Then: M5 functional checklist on [mac] and the Windows subset of M6 on [win] against the new KNIME. Record in a new verification receipt.
   - If it passes: add the version to the verified list, release a patch (`0.6.x`) with no code change except the list.
   - If it fails: fix, release, update table. Until then the bridge is read-only on that KNIME version.
5. **Dropping old versions**: support the current and previous KNIME minor; older ones stay listed as "last verified with bridge 0.x".

## 5. Risk register

| ID | Risk | Likelihood | Impact | Mitigation | Owner milestone |
|---|---|---|---|---|---|
| R1 | No license, so the extension and `.mcpb` cannot be redistributed | Certain until `LICENSE` is committed | Blocks release | GPL-3.0 chosen (D1); commit it in M0 | M0 |
| R2 | KNIME internal API change breaks the bridge on a KNIME update | High (every ~6 weeks) | High | Version policy section 4; compile check in CI; linkage-error wrapper | M1, M7 |
| R3 | Tycho cannot resolve KNIME internal bundles from public p2 sites, or rejects internal package access | Medium | Medium | Directory target against installed KNIME; keep legacy javac compile | M1 |
| R4 | p2-installed bundle does not auto-start | Medium | High | `p2.inf` markStarted/startLevel; fallback `org.eclipse.ui.startup` + lazy activation | M3 |
| R5 | Strict version range blocks users from updating KNIME | High if strict | High | Loose range + runtime gate (D3) | M3 |
| R6 | Unsigned-content warning, SmartScreen or Defender scare non-technical users | High | Medium | Install guide screenshots; no signing (D8), revisit if users get stuck | M6 |
| R7 | Claude Desktop's bundled Node is older than 22 | Low to medium | High | Check in M0; lower `engines` if features allow, or ship a Node binary (`server.type: binary`) | M0, M4 |
| R8 | Node and Java disagree on runtime dir or write classification | Medium | Medium | Same default dir; Node reads `writePolicy` from `session.json` | M1, M4 |
| R9 | Read-only gate misses a mutating gateway method | Low | High | Gateway calls not in `GATEWAY_READS` are already writes; unknown ops default to write | M3 |
| R10 | Canvas/viewport capture behaves differently on macOS (Cocoa, Equo) | Medium | Low | macOS is dev platform; document gaps | M2 |
| R11 | Installing into a signed macOS `.app` breaks its signature or Gatekeeper | Medium | Low (dev only) | Record in M0; use a copied app for dev | M0 |
| R12 | Admin-installed KNIME needs elevation for extension install | Medium | Medium | Document; recommend per-user install | M6 |
| R13 | `org.knime.*` namespace causes confusion or a collision | Medium | Medium | Rename symbolic name (D2) | M1 |
| R14 | Changing default runtime dir breaks existing launcher users and named profiles | High for existing users | Low | Launcher keeps passing explicit runtime; migration note (D7) | M1 |
| R15 | GUI-dependent smoke tests cannot run on hosted CI | Medium | Medium | Compile-level CI only; live tests manual per section 4 (D11) | M7 |
| R16 | Users' real workspaces get modified by an agent once writes are on | High (on by default since D4 changed) | High | Either switch turns writes off without restart; context/revision guards; native undo for graph edits; install guide explains the switches | M3, M4 |
| R17 | zod 3 advisory GHSA-mrhx-c7xc-m3w5 (memory exhaustion on oversized constrained collections); fix requires zod 4, a breaking change to every tool schema | Low: inputs come only from the local MCP host | Medium | Migrate to zod 4 before a public release |
| R18 | `knime_selection` reads KNIME's internal Pinia `selection` and `workflow` stores through a fixed script in the editor browser; a KNIME UI release can rename them | Medium per KNIME release | Low (the tool reports `available:false`, nothing else depends on it) | Re-check on every KNIME bump (section 4); the result names `knimeUiVersion` |

## 6. Decisions (all made 2026-10-31)

| ID | Decision | Outcome | |
|---|---|---|---|
| D1 | License | **Decided 2026-10-31: GPL-3.0** for the whole repo. Add `LICENSE` in M0; feature license text and `.mcpb` `license` field use it. | |
| D2 | Bundle and package namespace | **Decided 2026-10-31: rename bundle symbolic name and feature ID only** (e.g. `io.github.<owner>.knime.agentbridge`, exact ID to confirm in M1). Java package `org.knime.agent` stays. Breaks v0.5 named profiles; add a migration note. | |
| D3 | KNIME version pinning | **Decided 2026-10-31: loose range `[5.12,6.0)` + runtime gate** (section 4). | |
| D4 | Where the write opt-in lives | **Changed 2026-10-31: read-write by default.** The KNIME preference stays (enforced in Java) but starts on; turning it off makes every client read-only. The `.mcpb` setting (M4) also defaults to on. | |
| D5 | What read-only allows | **Decided 2026-10-31: strict.** Only `OperationPolicy.READS` and `GATEWAY_READS`. No `desktop.openProject`, no exports. | |
| D6 | KNIME distribution channel | **Decided 2026-10-31: build the packages only** (update-site zip and `.mcpb`). You ship them yourself. No GitHub Pages site, no Hub listing for now. | |
| D7 | Legacy launcher and default runtime dir | **Decided 2026-10-31: leave the launcher** as the developer path. Node default moves to `~/.knime-agent/runtime`; the launcher keeps passing its own runtime explicitly. | |
| D8 | Code signing | **Decided 2026-10-31: no signing.** SHA-256 checksums only. | |
| D9 | Other clients | **Decided 2026-10-31: Codex and Claude.** Claude Desktop via `.mcpb`; Codex and Claude Code via registration scripts. No generic client docs. | |
| D10 | Canvas in the `.mcpb` | **Decided 2026-10-31: off by default**, toggle in extension settings. | |
| D11 | Live KNIME tests in CI | **Decided 2026-10-31: manual per release.** | |
| D12 | macOS status | **Changed 2026-10-31: macOS first.** The user wants a working macOS install (M3 to M5 on mac) before the Windows work (M6). Windows stays the release target. | |

## 7. Order and human steps

An agent can do the code, build and scripted checks. Progress is gated by the steps below, which need you.

| Milestone | Where | Needs you for |
|---|---|---|
| M0 Recon | mac | Nothing left (all decisions made) |
| M1 Cross-platform build | both | Running the build and unit tests on the Windows machine |
| M2 Bundle on macOS | mac | Approving KNIME launches; dismissing first-run dialogs |
| M3 KNIME extension | mac now, win later | Clicking through the Install Extensions dialog, restart and uninstall on each OS |
| M4 `.mcpb` | mac now, win later | Double-click install in Claude Desktop; toggling settings; a Windows box with no Node |
| M5 Functional pass | mac | Driving Claude Desktop chats; reviewing the canvas image |
| M6 Windows acceptance | win | The whole milestone (clean account, SmartScreen/Defender prompts, screenshots) |
| M7 Release | both | Enabling Actions, tagging, shipping the built files (D6) |

Order (D12, changed 2026-10-31): finish M3, M4 and M5 on macOS first so there is a working result to try, then do the Windows halves of M1, M3 and M4 together with M6.

Critical path: committing the GPL-3.0 `LICENSE` gates publishing in M3, M4 and M7. M1 Tycho resolution (R3) is the largest technical unknown; do it first in M1, before anything else.
