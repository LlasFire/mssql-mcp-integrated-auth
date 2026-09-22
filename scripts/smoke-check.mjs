#!/usr/bin/env node
// Manual end-to-end smoke test. Unlike test/guards.test.mjs, this needs a
// real sources.json and real network/SQL Server access, so it is NOT part
// of `npm test` and does NOT run in CI. It is deliberately named
// smoke-check.mjs, not smoke-test.mjs: Node's test runner auto-discovers
// any *-test.mjs file by default, and this script must never run as a
// side effect of a bare `node --test`. Run it yourself after cloning and
// setting up sources.json, to confirm the server actually talks to your
// environments:
//
//   npm run smoke-test
//   npm run smoke-test -- --env dev
//
// It spawns the real server over stdio, does the MCP initialize handshake
// by hand (no test-only shortcuts), then calls list_environments and, for
// one environment, list_databases. It prints what it finds and exits
// non-zero on any failure.

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, '..', 'mssql-server.mjs');

const args = process.argv.slice(2);
const envFlagIdx = args.indexOf('--env');
const requestedEnv = envFlagIdx >= 0 ? args[envFlagIdx + 1] : null;

function startClient() {
  const child = spawn('node', [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const pending = new Map();
  let nextId = 1;

  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[server stderr] ${chunk}`);
  });

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  });

  function send(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`Timed out waiting for response to ${method}`));
        }
      }, 40000);
    });
  }

  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  return { child, send, notify };
}

async function callTool(client, name, toolArgs = {}) {
  const result = await client.send('tools/call', { name, arguments: toolArgs });
  if (result?.isError) {
    const text = result.content?.map((c) => c.text).join('\n') ?? 'unknown tool error';
    throw new Error(text);
  }
  return result;
}

async function main() {
  console.log(`Spawning server: node ${serverPath}`);
  const client = startClient();

  try {
    console.log('Sending MCP initialize handshake...');
    await client.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '1.0.0' },
    });
    client.notify('notifications/initialized', {});

    console.log('\nCalling list_environments...');
    const envResult = await callTool(client, 'list_environments');
    const environments = JSON.parse(envResult.content[0].text);
    console.log(`Found ${environments.length} environment(s):`, environments.map((e) => e.id).join(', '));
    if (environments.length === 0) {
      throw new Error('sources.json has no environments configured. Set it up before running this script.');
    }

    const targetEnv = requestedEnv || environments[0].id;
    if (!environments.some((e) => e.id === targetEnv)) {
      throw new Error(`Requested --env '${targetEnv}' is not in sources.json (have: ${environments.map((e) => e.id).join(', ')})`);
    }

    console.log(`\nCalling list_databases against '${targetEnv}'...`);
    const dbResult = await callTool(client, 'list_databases', { env: targetEnv });
    const databases = JSON.parse(dbResult.content[0].text);
    console.log(`Connected. Saw ${databases.length} database(s) on '${targetEnv}'.`);

    console.log('\nSmoke test passed: MCP handshake, list_environments, and a real');
    console.log('Windows-integrated SQL connection all worked end to end.');
    client.child.kill();
    process.exit(0);
  } catch (err) {
    console.error('\nSmoke test FAILED:', err.message);
    client.child.kill();
    process.exit(1);
  }
}

main();
