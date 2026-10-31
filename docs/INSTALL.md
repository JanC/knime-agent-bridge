# Installing the KNIME extension

The bridge ships as a zipped update site, `knime-agent-bridge-update-site-<version>.zip`. Build it with `mvn -B verify`; it lands in `releng/update-site/target/`. Needs KNIME Analytics Platform 5.12.

## Install

1. In KNIME, open **Preferences** (top right) > **Install/Update** > **Available Software Sites** > **Add...** > **Archive...**, pick the zip, name it "KNIME Agent Bridge", then **Add** and **Apply and Close**.
2. Open **Menu** > **Install Extensions...**. Expand **KNIME Agent Bridge (community)**, tick **KNIME Agent Bridge** and click **Next**.
3. Accept the GPL-3.0 license and click **Finish**.
4. KNIME warns that the content is unsigned. The extension is not signed (decision D8); choose **Install Anyway** if you trust the zip you built or received.
5. Restart KNIME when asked.

After the restart the bridge runs by itself. It writes its session to `~/.knime-agent/runtime` (Windows: `%USERPROFILE%\.knime-agent\runtime`). Check with:

```
node src/cli.mjs sessions
```

## Allowing or blocking changes

**Preferences** > **KNIME** > **Agent Bridge** has one option: "Allow AI agents to modify, execute and save workflows". It is **on** by default. Turn it off to make every connected agent read-only: agents can still see open workflows, settings, tables and the canvas, and any change is refused with `WRITES_DISABLED` before it reaches KNIME. The setting applies immediately, without a restart.

## Connecting Claude Desktop

Build the bundle with `npm run build:mcpb` (output: `artifacts/knime-agent-bridge-<version>.mcpb`, about 6 MB). Double-click it, or drag it onto Claude Desktop's **Settings > Extensions** page, and click **Install**. Claude Desktop runs it with its own built-in Node.js; nothing else needs installing.

The extension has three settings:

- **Allow changes** (on): turn off to keep Claude read-only. KNIME's own switch (below) must also allow changes.
- **Canvas images** (off): lets Claude render pictures of the workflow. Needs Google Chrome or Microsoft Edge.
- **Browser for canvas images** (empty): a Chrome, Edge or Chromium executable if neither is found automatically.

KNIME must be running with the extension installed; otherwise the tools report that no KNIME session is available.

## Connecting Claude Code or Codex

From a checkout of this repository:

```
node scripts/register-claude-code.mjs
node scripts/register-codex.mjs
```

Add `--read-only` to either to register the server with changes turned off.

## Uninstall

**Menu** > **Help** > **About KNIME Analytics Platform** > **Installation Details**, select **KNIME Agent Bridge**, **Uninstall...**, then restart. KNIME stops loading the bridge at once; p2 removes the JAR from `plugins/` during a later cleanup.

## macOS notes

Installing any extension modifies files inside the KNIME app, so `codesign --verify` reports "a sealed resource is missing or invalid". KNIME's own app already reports this after its first start; it does not stop KNIME from launching.
