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
import {
  buildListTablesSql,
  buildListViewsSql,
  buildListStoredProceduresSql,
  buildListFunctionsSql,
  buildListTriggersSql,
  buildDescribeParametersSql,
  buildDescribeProcedureDefinitionSql,
  buildDescribeFunctionDefinitionSql,
  buildDescribeTriggerSql,
  buildDescribeColumnsSql,
  buildDescribePrimaryKeySql,
  buildDescribeForeignKeysSql,
  buildDescribeUniqueConstraintsSql,
  buildDescribeCheckConstraintsSql,
} from './lib/schema-queries.mjs';
import { stripBom } from './lib/json-utils.mjs';
import { assertSafeIdentifier } from './lib/sql-identifiers.mjs';
import { buildExecProcedureSql, buildTvpMetadataSql, groupTvpMetadata } from './lib/procedure-exec.mjs';
import { isExecutePermissionDenied } from './lib/sql-errors.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sources = JSON.parse(stripBom(readFileSync(path.join(__dirname, 'sources.json'), 'utf8')));
const envIds = sources.map((s) => s.id);
const logPath = path.join(__dirname, 'query-log.jsonl');

// `database` is never embedded in SQL text; it goes into the connection
// string worker.ps1 builds, so a stray ';' in it can inject connection
// properties (see assertSafeIdentifier). Reject that shape at the MCP
// boundary instead of only in the worker.
const databaseSchema = z.string().refine(
  (v) => { try { assertSafeIdentifier(v, 'database'); return true; } catch { return false; } },
  { message: 'database must be a plain SQL Server identifier (letters, digits, or _ $ # @)' }
).optional();

// One stored-procedure parameter value: a plain SQL scalar for a normal
// parameter, or an array for a table-valued parameter - a plain array of
// scalars for a single-column table type, or an array of objects keyed by
// column name for a multi-column one. The array form's real type/columns
// get resolved from the procedure's own metadata at call time (see
// buildTvpMetadataSql), not declared by the caller.
const procScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const procParamValueSchema = z.union([
  procScalarSchema,
  z.array(procScalarSchema),
  z.array(z.record(procScalarSchema)),
]);

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

// The Claude Code skill at .claude/skills/mssql-mcp-integrated-auth/SKILL.md
// (discovery order, cross-env comparison, safety rules, error troubleshooting)
// previously only reached Claude by living in the same repo as this server -
// no relationship an MCP client could see. Serving it as an MCP resource
// means any client, not just Claude Code with this repo checked out, can
// fetch the same usage guide straight from the server.
const SKILL_PATH = path.join(__dirname, '.claude', 'skills', 'mssql-mcp-integrated-auth', 'SKILL.md');

// Strips the skill file's YAML frontmatter (name/description for Claude
// Code's own skill loader) so the resource serves just the usage guide.
function stripFrontmatter(md) {
  return md.replace(/^---\n[\s\S]*?\n---\n/, '');
}

server.registerResource(
  'usage-guide',
  'mssql-integrated://usage-guide',
  {
    title: 'mssql-integrated usage guide',
    description: 'Discovery order, cross-environment comparison, safety rules, and error ' +
      'troubleshooting for this server\'s tools. Read this before writing ad hoc SQL.',
    mimeType: 'text/markdown',
  },
  async (uri) => {
    let text;
    try {
      text = stripFrontmatter(readFileSync(SKILL_PATH, 'utf8'));
    } catch {
      throw new Error(`Usage guide not found at ${SKILL_PATH}.`);
    }
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
  }
);

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
    description: 'List base tables (not views) in a database on a given environment, optionally ' +
      'filtered to one schema. Returns schema/table name pairs only, no columns. Use list_views for ' +
      'views, or describe_table for one table\'s columns and constraints.',
    inputSchema: { env: envEnum, database: databaseSchema, schema: z.string().optional() },
  },
  async ({ env, database, schema }) => {
    const result = await callWorker({ env, database, sql: buildListTablesSql(schema), maxRows: MAX_ROWS_CEILING });
    if (!result.ok) throw new Error(result.error);
    return { content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) }] };
  }
);

server.registerTool(
  'list_views',
  {
    description: 'List views (not base tables) in a database on a given environment, optionally ' +
      'filtered to one schema. Returns schema/view name pairs only, not their definitions.',
    inputSchema: { env: envEnum, database: databaseSchema, schema: z.string().optional() },
  },
  async ({ env, database, schema }) => {
    const result = await callWorker({ env, database, sql: buildListViewsSql(schema), maxRows: MAX_ROWS_CEILING });
    if (!result.ok) throw new Error(result.error);
    return { content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) }] };
  }
);

server.registerTool(
  'list_stored_procedures',
  {
    description: 'List stored procedures in a database on a given environment, optionally filtered ' +
      'to one schema. Returns schema/procedure name pairs only, not their parameters or body; use ' +
      'describe_procedure for that.',
    inputSchema: { env: envEnum, database: databaseSchema, schema: z.string().optional() },
  },
  async ({ env, database, schema }) => {
    const result = await callWorker({ env, database, sql: buildListStoredProceduresSql(schema), maxRows: MAX_ROWS_CEILING });
    if (!result.ok) throw new Error(result.error);
    return { content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) }] };
  }
);

server.registerTool(
  'list_functions',
  {
    description: 'List user-defined functions (scalar, inline table-valued, and multi-statement ' +
      'table-valued) in a database on a given environment, optionally filtered to one schema. ' +
      'Returns schema/function name/return-type only, not their parameters or body; use ' +
      'describe_function for that.',
    inputSchema: { env: envEnum, database: databaseSchema, schema: z.string().optional() },
  },
  async ({ env, database, schema }) => {
    const result = await callWorker({ env, database, sql: buildListFunctionsSql(schema), maxRows: MAX_ROWS_CEILING });
    if (!result.ok) throw new Error(result.error);
    return { content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) }] };
  }
);

server.registerTool(
  'list_triggers',
  {
    description: 'List DML triggers (AFTER or INSTEAD OF triggers on INSERT/UPDATE/DELETE against a ' +
      'table) in a database on a given environment, optionally filtered to one table. For each ' +
      'trigger, returns which table it is on, whether it is an INSTEAD OF trigger, and whether it is ' +
      'currently disabled. Does not return trigger bodies (use describe_trigger for that) and does ' +
      'not include database-level or server-level triggers, only ordinary table triggers.',
    inputSchema: { env: envEnum, database: databaseSchema, table: z.string().optional() },
  },
  async ({ env, database, table }) => {
    const result = await callWorker({ env, database, sql: buildListTriggersSql(table), maxRows: MAX_ROWS_CEILING });
    if (!result.ok) throw new Error(result.error);
    return { content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) }] };
  }
);

server.registerTool(
  'describe_table',
  {
    description: 'Deep inspection of one table: columns (name, data type, nullability, max length), ' +
      'its primary key, its foreign keys (with the referenced schema/table/column), its unique ' +
      'constraints, and its check constraints. This is a schema inspection tool: it never returns ' +
      'row data, only structure. Throws if the table does not exist or is not visible.',
    inputSchema: { env: envEnum, table: z.string(), database: databaseSchema, schema: z.string().optional() },
  },
  async ({ env, table, database, schema }) => {
    const columnsResult = await callWorker({ env, database, sql: buildDescribeColumnsSql(table, schema), maxRows: MAX_ROWS_CEILING });
    if (!columnsResult.ok) throw new Error(columnsResult.error);
    if (columnsResult.rows.length === 0) {
      throw new Error(`Table '${table}' not found (or no columns visible) in that database.`);
    }
    const pkResult = await callWorker({ env, database, sql: buildDescribePrimaryKeySql(table, schema), maxRows: MAX_ROWS_CEILING });
    if (!pkResult.ok) throw new Error(pkResult.error);
    const fkResult = await callWorker({ env, database, sql: buildDescribeForeignKeysSql(table, schema), maxRows: MAX_ROWS_CEILING });
    if (!fkResult.ok) throw new Error(fkResult.error);
    const uniqueResult = await callWorker({ env, database, sql: buildDescribeUniqueConstraintsSql(table, schema), maxRows: MAX_ROWS_CEILING });
    if (!uniqueResult.ok) throw new Error(uniqueResult.error);
    const checkResult = await callWorker({ env, database, sql: buildDescribeCheckConstraintsSql(table, schema), maxRows: MAX_ROWS_CEILING });
    if (!checkResult.ok) throw new Error(checkResult.error);
    const body = {
      columns: columnsResult.rows,
      primaryKey: pkResult.rows.map((r) => r.COLUMN_NAME),
      foreignKeys: fkResult.rows,
      uniqueConstraints: uniqueResult.rows,
      checkConstraints: checkResult.rows,
    };
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
  }
);

server.registerTool(
  'describe_procedure',
  {
    description: 'Deep inspection of one stored procedure: its parameters (name, data type, and ' +
      'whether each is IN or OUT/INOUT) and its full T-SQL definition (the CREATE PROCEDURE body), ' +
      'so you can read exactly what it does before deciding whether to run it. The definition field ' +
      'comes back empty if the procedure is encrypted (WITH ENCRYPTION) or you lack VIEW DEFINITION ' +
      'permission on it; that is a SQL Server restriction, not a bug in this tool. Throws if no ' +
      'procedure with that name is visible.',
    inputSchema: { env: envEnum, name: z.string(), database: databaseSchema, schema: z.string().optional() },
  },
  async ({ env, name, database, schema }) => {
    const paramsResult = await callWorker({ env, database, sql: buildDescribeParametersSql(name, schema), maxRows: MAX_ROWS_CEILING });
    if (!paramsResult.ok) throw new Error(paramsResult.error);
    const defResult = await callWorker({ env, database, sql: buildDescribeProcedureDefinitionSql(name, schema), maxRows: 1 });
    if (!defResult.ok) throw new Error(defResult.error);
    if (defResult.rows.length === 0) {
      throw new Error(`Stored procedure '${name}' not found (or not visible) in that database.`);
    }
    const body = {
      schema: defResult.rows[0].TABLE_SCHEMA,
      parameters: paramsResult.rows,
      definition: defResult.rows[0].DEFINITION,
    };
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
  }
);

server.registerTool(
  'execute_procedure',
  {
    description: 'Execute a stored procedure with the given input parameters and return its first ' +
      'result set. Unlike every other tool in this server, this is NOT read-only: the procedure runs ' +
      'with whatever permissions your Windows account has in that environment, and can insert, update, ' +
      'or delete data if its body does. Use describe_procedure first to see what it actually does and ' +
      'what parameters it expects before calling this. For a table-valued parameter (a parameter whose ' +
      'type is a user-defined table type, not a scalar), pass an array instead of a plain value: a flat ' +
      'array of scalars (e.g. ["Admins", "Users"]) for a single-column table type, or an array of ' +
      'objects keyed by column name for a multi-column one. You do not need to know the type\'s real ' +
      'schema-qualified name or column list ahead of time - this tool looks that up from the ' +
      'procedure\'s own metadata; if the parameter name doesn\'t match an actual table-valued parameter, ' +
      'the error says so and points at describe_procedure. Limitations: only input parameters are ' +
      'supported (no OUTPUT/return value), and only the first result set is returned if the procedure ' +
      'produces more than one. If the account lacks EXECUTE permission on the procedure, the error says ' +
      'so explicitly - propose to the person that you read the procedure with describe_procedure and, ' +
      'if they still want the same effect, rewrite its logic as a plain SELECT with their parameter ' +
      'values substituted in and run that via run_query (this only works if the account has SELECT on ' +
      'the underlying tables, and only for read logic - do not attempt this for a procedure that writes ' +
      'data). Do this as a proposal the person confirms, not a silent substitution: a hand-rewritten ' +
      'query is not guaranteed to be equivalent to the procedure\'s real logic.',
    inputSchema: {
      env: envEnum,
      name: z.string(),
      database: databaseSchema,
      schema: z.string().optional(),
      params: z.record(procParamValueSchema).optional(),
    },
  },
  async ({ env, name, database, schema, params }) => {
    const started = Date.now();
    let sql;
    try {
      const tvpParamNames = Object.entries(params || {})
        .filter(([, value]) => Array.isArray(value))
        .map(([paramName]) => paramName);
      let tvpMeta = {};
      if (tvpParamNames.length > 0) {
        const metaResult = await callWorker({ env, database, sql: buildTvpMetadataSql(name, schema), maxRows: MAX_ROWS_CEILING });
        if (!metaResult.ok) throw new Error(metaResult.error);
        tvpMeta = groupTvpMetadata(metaResult.rows);
        for (const paramName of tvpParamNames) {
          if (!tvpMeta[`@${paramName}`]) {
            throw new Error(
              `'${paramName}' was passed as a list, but '${name}' has no table-valued parameter named ` +
              `'@${paramName}'. Use describe_procedure to check the real parameter names.`
            );
          }
        }
      }
      sql = buildExecProcedureSql(name, schema, params, tvpMeta);
      const result = await callWorker({ env, database, sql, maxRows: MAX_ROWS_CEILING });
      if (!result.ok) throw new Error(result.error);
      log({ env, database: database || null, sql, rowCount: result.rowCount, truncated: result.truncated, ms: Date.now() - started, ok: true });
      const note = result.truncated ? `\n\n[truncated at ${MAX_ROWS_CEILING} rows]` : '';
      return { content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) + note }] };
    } catch (err) {
      log({ env, database: database || null, sql: sql || null, ms: Date.now() - started, ok: false, error: err.message });
      if (isExecutePermissionDenied(err.message)) {
        throw new Error(
          `${err.message} Your account doesn't have EXECUTE permission on this procedure in '${env}'. ` +
          'Use describe_procedure to read its definition, then propose to the person rewriting its ' +
          'logic as a plain SELECT with their parameter values substituted in and running that via ' +
          "run_query - only if they confirm, only if it's read logic, and only if the account has " +
          'SELECT on the underlying tables.'
        );
      }
      throw err;
    }
  }
);

server.registerTool(
  'describe_function',
  {
    description: 'Deep inspection of one user-defined function (scalar, inline table-valued, or ' +
      'multi-statement table-valued): its parameters and its full T-SQL definition (the CREATE ' +
      'FUNCTION body). Same encryption/permission caveat as describe_procedure: the definition field ' +
      'comes back empty if it is encrypted or not visible to you. Throws if no function with that ' +
      'name is visible.',
    inputSchema: { env: envEnum, name: z.string(), database: databaseSchema, schema: z.string().optional() },
  },
  async ({ env, name, database, schema }) => {
    const paramsResult = await callWorker({ env, database, sql: buildDescribeParametersSql(name, schema), maxRows: MAX_ROWS_CEILING });
    if (!paramsResult.ok) throw new Error(paramsResult.error);
    const defResult = await callWorker({ env, database, sql: buildDescribeFunctionDefinitionSql(name, schema), maxRows: 1 });
    if (!defResult.ok) throw new Error(defResult.error);
    if (defResult.rows.length === 0) {
      throw new Error(`Function '${name}' not found (or not visible) in that database.`);
    }
    const body = {
      schema: defResult.rows[0].TABLE_SCHEMA,
      parameters: paramsResult.rows,
      definition: defResult.rows[0].DEFINITION,
    };
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
  }
);

server.registerTool(
  'describe_trigger',
  {
    description: 'Deep inspection of one DML trigger: its full T-SQL definition, which table it is ' +
      'attached to, whether it fires INSTEAD OF the triggering statement (vs. AFTER), and whether it ' +
      'is currently disabled. The specific INSERT/UPDATE/DELETE events it fires on are visible in the ' +
      'definition text itself (the trigger\'s FOR/AFTER clause), not returned as separate fields. ' +
      'Throws if no table trigger with that name is visible.',
    inputSchema: { env: envEnum, trigger: z.string(), database: databaseSchema },
  },
  async ({ env, trigger, database }) => {
    const result = await callWorker({ env, database, sql: buildDescribeTriggerSql(trigger), maxRows: 1 });
    if (!result.ok) throw new Error(result.error);
    if (result.rows.length === 0) {
      throw new Error(`Trigger '${trigger}' not found (or not visible) in that database.`);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result.rows[0], null, 2) }] };
  }
);

server.registerTool(
  'run_query',
  {
    description: 'Run a single read-only (SELECT/WITH) SQL query against an environment and database. ' +
      'This is the tool for ad hoc, exploratory queries once you know the shape of the data, e.g. ' +
      'from list_tables/describe_table/list_stored_procedures/etc.: write the T-SQL yourself and run ' +
      'it here. Writes and multi-statement batches are blocked. Results are capped (default 200 ' +
      'rows, max 2000).',
    inputSchema: {
      env: envEnum,
      sql: z.string(),
      database: databaseSchema,
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
