import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { directorArgs, elevatedCommand, installedBundle, isKnimeHome, knimeExecutable, knimeVersion, removeServerBlock, serverBlock, tomlString, updateCodexConfig, FEATURE_IU } from '../installer/windows/setup.mjs';

const existing = `model = "gpt-5"

[mcp_servers.github]
command = "github-mcp"

[mcp_servers.knime-agent]
command = '/old/node'
args = ['/old/server.mjs']

[mcp_servers.knime-agent.env]
KNIME_AGENT_ALLOW_WRITES = "false"

[mcp_servers.context7]
url = "https://example.invalid/mcp"
`;

test('the Codex entry replaces only the knime-agent tables', () => {
  const block = serverBlock({ command: 'C:\\Users\\Jane Doe\\AppData\\Local\\KnimeAgentBridge\\node\\node.exe', server: 'C:\\Users\\Jane Doe\\AppData\\Local\\KnimeAgentBridge\\server\\src\\server.mjs' });
  const next = updateCodexConfig(existing, block);
  assert.match(next, /\[mcp_servers\.github\]\ncommand = "github-mcp"/);
  assert.match(next, /\[mcp_servers\.context7\]\nurl = "https:\/\/example\.invalid\/mcp"/);
  assert.equal(next.match(/\[mcp_servers\.knime-agent\]/g).length, 1);
  assert.doesNotMatch(next, /\/old\/node|"false"/);
  assert.match(next, /command = 'C:\\Users\\Jane Doe\\AppData\\Local\\KnimeAgentBridge\\node\\node\.exe'/);
  assert.match(next, /KNIME_AGENT_ALLOW_WRITES = "true"/);
  assert.equal(updateCodexConfig(next, block), next, 'running setup twice changes nothing');
});

test('removing the entry keeps the rest, and an empty file gets just the entry', () => {
  const removed = updateCodexConfig(existing, null);
  assert.doesNotMatch(removed, /knime-agent/);
  assert.match(removed, /model = "gpt-5"[\s\S]*\[mcp_servers\.github\][\s\S]*\[mcp_servers\.context7\]/);
  assert.equal(updateCodexConfig(null, serverBlock({ command: 'n', server: 's' })), serverBlock({ command: 'n', server: 's' }));
  assert.equal(removeServerBlock('[mcp_servers."knime-agent"]\ncommand = "x"\n[other]\na = 1'), '[other]\na = 1');
});

test('TOML strings keep Windows backslashes literally', () => {
  assert.equal(tomlString('C:\\a b\\node.exe'), "'C:\\a b\\node.exe'");
  assert.equal(tomlString("C:\\O'Brien\\node.exe"), '"C:\\\\O\'Brien\\\\node.exe"');
});

test('KNIME detection reads the folder layout, version and installed bundle', () => {
  const dir = path.join('K', 'KNIME');
  const files = new Set([path.join(dir, 'knime.ini'), path.join(dir, 'configuration', 'config.ini')]);
  assert.equal(isKnimeHome(dir, f => files.has(f)), true);
  assert.equal(isKnimeHome(path.join('K', 'Other'), f => files.has(f)), false);
  assert.equal(knimeVersion(dir, () => ['org.knime.core_5.4.1.v1', 'org.knime.core_5.12.0.v202606180846', 'org.knime.base_5.12.0']), '5.12.0');
  assert.deepEqual(installedBundle(dir, () => 'org.a,1,plugins/a.jar,4,false\nio.github.juniper234.knime.agentbridge,0.6.0.2026,plugins/x.jar,4,true\n'), { version: '0.6.0.2026' });
  assert.equal(installedBundle(dir, () => 'org.a,1,plugins/a.jar,4,false\n'), null);
  assert.equal(knimeExecutable('C:\\KNIME', 'win32').endsWith('knime.exe'), true);
});

test('p2 director arguments use an encoded jar URI for paths with spaces', () => {
  const args = directorArgs({ repositoryZip: path.resolve('/tmp/Jane Doe/site.zip'), data: '/tmp/d' });
  const repository = args[args.indexOf('-repository') + 1];
  assert.match(repository, /^jar:file:.*Jane%20Doe\/site\.zip!\/$/);
  assert.equal(args[args.indexOf('-installIU') + 1], FEATURE_IU);
  assert.ok(directorArgs({ repositoryZip: '/x.zip', data: '/d', uninstall: true }).includes('-uninstallIU'));
});

test('elevated command quotes PowerShell and process arguments', () => {
  const command = elevatedCommand("C:\\Program Files\\KNIME\\knime.exe", ['-data', "C:\\Users\\O'Brien\\tmp"]);
  assert.match(command, /-FilePath 'C:\\Program Files\\KNIME\\knime\.exe'/);
  assert.match(command, /-ArgumentList '"-data" "C:\\Users\\O''Brien\\tmp"'/);
  assert.match(command, /-Verb RunAs -Wait -PassThru; exit \$p\.ExitCode$/);
});
