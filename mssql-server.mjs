#!/usr/bin/env node
// MSSQL MCP server: Windows-integrated (SSO) auth only, no credentials
// anywhere in this file or its config. Built on the official MCP SDK.
// A single persistent PowerShell worker keeps SqlConnections open across
// calls instead of paying process + connect cost on every query.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn } from 'child_process';
import { readFileSync, appendFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertReadOnly, clampMaxRows, MAX_ROWS_CEILING } from './lib/guards.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sources = JSON.parse(readFileSync(path.join(__dirname, 'sources.json'), 'utf8'));
const envIds = sources.map((s) => s.id);
const logPath = path.join(__dirname, 'query-log.jsonl');

function log(entry) {
  try {
    appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    // logging is best-effort, never fail a call because of it
  }
}

// --- persistent PowerShell worker (lazy start, auto-restart on crash) ---
let worker = null;
let pending = [];
let buffer = '';

function ensureWorker() {
  if (worker && !worker.killed) return worker;
  worker = spawn(
    'powershell.exe',
    ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'worker.ps1')],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  buffer = '';
  worker.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const p = pending.shift();
      if (!p) continue;
      try { p.resolve(JSON.parse(line)); } catch (e) { p.reject(e); }
    }
  });
  worker.on('exit', () => {
    worker = null;
    while (pending.length) pending.shift().reject(new Error('SQL worker process exited unexpectedly.'));
  });
  return worker;
}

function callWorker(req, timeoutMs = 40000) {
  return new Promise((resolve, reject) => {
    const w = ensureWorker();
    const entry = { resolve, reject };
    pending.push(entry);
    w.stdin.write(JSON.stringify(req) + '\n');
    setTimeout(() => {
      const idx = pending.indexOf(entry);
      if (idx >= 0) {
        pending.splice(idx, 1);
        reject(new Error(`SQL request timed out after ${timeoutMs / 1000}s.`));
      }
    }, timeoutMs);
  });
}

process.on('exit', () => { if (worker) worker.kill(); });
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// Safety guards (isSingleStatement, isReadOnly, assertReadOnly, clampMaxRows,
// MAX_ROWS_DEFAULT/MAX_ROWS_CEILING) live in ./lib/guards.mjs so they can be
// unit-tested (see test/guards.test.mjs) without a live SQL connection.

const server = new McpServer({ name: 'mssql-integrated', version: '2.0.0' });
const envEnum = z.enum(envIds);

server.registerTool(
  'list_environments',
  { description: 'List the configured SQL Server environments and their host/instance.' },
  async () => ({
    content: [{ type: 'text', text: JSON.stringify(sources.map((s) => ({
      id: s.id,
      server: s.instanceName ? `${s.host}\\${s.instanceName}` : s.host,
      defaultDatabase: s.database || 'master',
    })), null, 2) }],
  })
);

server.registerTool(
  'list_databases',
  {
    description: 'List database names on a given environment, via Windows-integrated auth.',
    inputSchema: { env: envEnum },
  },
  async ({ env }) => {
    const result = await callWorker({ env, database: 'master', sql: 'SELECT name FROM sys.databases ORDER BY name', maxRows: MAX_ROWS_CEILING });
    if (!result.ok) throw new Error(result.error);
    return { content: [{ type: 'text', text: JSON.stringify(result.rows.map((r) => r.name), null, 2) }] };
  }
);

server.registerTool(
  'list_tables',
  {
    description: 'List tables in a database on a given environment.',
    inputSchema: { env: envEnum, database: z.string().optional(), schema: z.string().optional() },
  },
  async ({ env, database, schema }) => {
    const sql = schema
      ? `SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = '${schema.replace(/'/g, "''")}' ORDER BY TABLE_NAME`
      : `SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME`;
    const result = await callWorker({ env, database, sql, maxRows: MAX_ROWS_CEILING });
    if (!result.ok) throw new Error(result.error);
    return { content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) }] };
  }
);

server.registerTool(
  'describe_table',
  {
    description: 'List columns, types, and nullability for a table.',
    inputSchema: { env: envEnum, table: z.string(), database: z.string().optional(), schema: z.string().optional() },
  },
  async ({ env, table, database, schema }) => {
    const schemaFilter = schema ? ` AND TABLE_SCHEMA = '${schema.replace(/'/g, "''")}'` : '';
    const sql = `SELECT TABLE_SCHEMA, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH ` +
      `FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${table.replace(/'/g, "''")}'${schemaFilter} ORDER BY ORDINAL_POSITION`;
    const result = await callWorker({ env, database, sql, maxRows: MAX_ROWS_CEILING });
    if (!result.ok) throw new Error(result.error);
    if (result.rows.length === 0) throw new Error(`Table '${table}' not found (or no columns visible) in that database.`);
    return { content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) }] };
  }
);

server.registerTool(
  'run_query',
  {
    description: 'Run a single read-only (SELECT/WITH) SQL query against an environment and database. ' +
      'Writes and multi-statement batches are blocked. Results are capped (default 200 rows, max 2000).',
    inputSchema: {
      env: envEnum,
      sql: z.string(),
      database: z.string().optional(),
      maxRows: z.number().int().positive().optional(),
    },
  },
  async ({ env, sql, database, maxRows }) => {
    const started = Date.now();
    try {
      assertReadOnly(sql);
      const cappedMaxRows = clampMaxRows(maxRows);
      const result = await callWorker({ env, database, sql, maxRows: cappedMaxRows });
      if (!result.ok) throw new Error(result.error);
      log({ env, database: database || null, sql, rowCount: result.rowCount, truncated: result.truncated, ms: Date.now() - started, ok: true });
      const note = result.truncated ? `\n\n[truncated at ${cappedMaxRows} rows]` : '';
      return { content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) + note }] };
    } catch (err) {
      log({ env, database: database || null, sql, ms: Date.now() - started, ok: false, error: err.message });
      throw err;
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
