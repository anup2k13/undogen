/** `undogen wrap [options] -- <command> [args...]` (experimental). */
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { c } from '../report.js';
import { FileJournalStore } from '../runtime.js';
import { VERSION } from '../version.js';
import { describePlan, planTools, type McpTool, type ToolOverrides } from './plans.js';
import { createWrapServer, listAllTools } from './server.js';
import { ToolSession, type ToolEntry } from './session.js';

export interface WrapFlags {
  /** Fixtures file: prove the plans against the (sandbox) server instead of serving. */
  verify?: string;
  /** A server reached over Streamable HTTP instead of a command. */
  url?: string;
  /** Headers for every request to that server, e.g. authorization. */
  headers?: Record<string, string>;
  journal?: string;
  overrides?: string;
  irreversible?: string;
  analyze?: boolean;
  json?: boolean;
  undo?: boolean;
  all?: boolean;
  seq?: string;
  after?: string;
  session?: string;
  force?: boolean;
  cascade?: boolean;
}

export class WrapUsageError extends Error {}

/**
 * Header values may name environment variables, `${GITHUB_TOKEN}`, so a token can stay out of MCP client
 * config files and process listings (the client starts undogen with its environment).
 */
export function expandHeaders(headers: Record<string, string>, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [
      k,
      v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
        const value = env[name];
        if (value === undefined) throw new WrapUsageError(`--header ${k} uses \${${name}}, which is not set`);
        return value;
      }),
    ]),
  );
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Connect to the server to wrap: started with the command after `--`, or at --url over Streamable HTTP. */
async function connectUpstream(command: string[], flags: WrapFlags): Promise<{ upstream: Client; http?: StreamableHTTPClientTransport; label: string }> {
  const upstream = new Client({ name: 'undogen-wrap', version: VERSION });
  const headers = expandHeaders(flags.headers ?? {});
  if (flags.url) {
    if (command.length) throw new WrapUsageError('give either --url or a command after --, not both');
    let url: URL;
    try {
      url = new URL(flags.url);
    } catch {
      throw new WrapUsageError(`--url is not a URL: ${flags.url}`);
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
      throw new WrapUsageError('--url must be https (plain http only for localhost): headers such as tokens would be sent unencrypted');
    }
    const label = `${url.origin}${url.pathname}`;
    // Header auth only (a token): servers that need an OAuth sign-in aren't supported yet.
    const http = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
    try {
      await upstream.connect(http);
    } catch (err) {
      const status = err instanceof StreamableHTTPError ? err.code : undefined;
      const auth = status === 401 || status === 403 || /\b40[13]\b|unauthori[sz]ed|forbidden/i.test((err as Error).message);
      const hint = !auth
        ? ''
        : Object.keys(headers).length
          ? `. The server refused the credentials${status ? ` (HTTP ${status})` : ''}: check the token and its scopes`
          : `. The server wants credentials${status ? ` (HTTP ${status})` : ''}: pass --header "authorization: Bearer \${YOUR_TOKEN_VARIABLE}"`;
      throw new Error(`Could not connect to ${label}: ${(err as Error).message}${hint}`);
    }
    return { upstream, http, label };
  }
  if (Object.keys(headers).length) throw new WrapUsageError('--header is for servers reached with --url; a command gets its credentials from the environment');
  const [cmd, ...args] = command;
  if (!cmd) throw new WrapUsageError('wrap needs the server to wrap: a command after --, e.g. undogen wrap -- npx -y @acme/mcp-server, or --url https://…');
  // The wrapped server gets this process's environment (it usually needs a token from it); its stderr is ours.
  await upstream.connect(new StdioClientTransport({ command: cmd, args, env: process.env as Record<string, string>, stderr: 'inherit' }));
  return { upstream, label: cmd };
}

export async function runWrap(flags: WrapFlags, command: string[]): Promise<number> {
  const mode = flags.irreversible ?? 'ask';
  if (!['ask', 'allow', 'deny'].includes(mode)) throw new WrapUsageError('--irreversible must be ask, allow or deny');
  const overrides = flags.overrides ? (JSON.parse(await readFile(flags.overrides, 'utf8')) as ToolOverrides) : undefined;
  if (flags.undo && !flags.journal) throw new WrapUsageError('wrap --undo needs --journal <file>');
  const { upstream, http, label } = await connectUpstream(command, flags);

  try {
    if (flags.analyze) {
      const plans = planTools((await listAllTools(upstream)) as McpTool[], overrides);
      if (flags.json) {
        console.log(JSON.stringify(plans, null, 2));
        return 0;
      }
      const name = (p: (typeof plans)[number]) => (p.dispatch ? `${p.tool} ${p.dispatch.arg}=${p.dispatch.value}` : p.tool);
      const w = Math.max(...plans.map((p) => name(p).length));
      const color = { reversible: c.green, compensable: c.yellow, irreversible: c.magenta, unknown: c.dim } as const;
      for (const p of plans) {
        const label = p.strategy === 'no-side-effects' ? c.dim('read-only'.padEnd(12)) : color[p.reversibility](p.reversibility.padEnd(12));
        console.log(`  ${name(p).padEnd(w)}  ${label} ${c.dim(describePlan(p))}`);
      }
      const count = (r: string) => plans.filter((p) => p.reversibility === r && p.strategy !== 'no-side-effects').length;
      const reads = plans.filter((p) => p.strategy === 'no-side-effects').length;
      console.log(`\n  ${plans.length} tools: ${reads} read-only · ${count('reversible')} reversible · ${count('compensable')} compensable · ${count('irreversible')} irreversible · ${count('unknown')} unknown`);
      return 0;
    }

    if (flags.verify) {
      const { verifyTools } = await import('./verify.js');
      for (const [flag, set] of [['--analyze', flags.analyze], ['--undo', flags.undo], ['--journal', flags.journal], ['--irreversible', flags.irreversible]] as const) {
        if (set) throw new WrapUsageError(`--verify doesn't use ${flag}: it calls nothing irreversible or unknown and undoes everything it does`);
      }
      const fixtures = JSON.parse(await readFile(flags.verify, 'utf8')) as import('./verify.js').WrapFixtures;
      const isCall = (c: unknown) => !!c && typeof c === 'object' && typeof (c as { tool?: unknown }).tool === 'string';
      const shape = `${flags.verify} should look like { "probe": { "tool": …, "arguments": {…} }, "setup": [ … ], "steps": [{ "tool": …, "arguments": {…} }] }`;
      if (!fixtures || typeof fixtures !== 'object' || !Array.isArray(fixtures.steps) || !fixtures.steps.every(isCall)) throw new WrapUsageError(shape);
      if (fixtures.setup !== undefined && !(Array.isArray(fixtures.setup) && fixtures.setup.every(isCall))) throw new WrapUsageError(shape);
      if (fixtures.probe !== undefined && ![fixtures.probe].flat().every(isCall)) throw new WrapUsageError(shape);
      const icons = { verified: c.green('✓'), compensated: c.yellow('≈'), failed: c.red('✗'), inconclusive: c.yellow('?'), gated: c.magenta('⛔'), error: c.red('!') } as const;
      const report = await verifyTools({
        call: async (name, args) => (await upstream.callTool({ name, arguments: args })) as never,
        plans: planTools((await listAllTools(upstream)) as McpTool[], overrides),
        fixtures,
        onResult: flags.json
          ? undefined
          : (r) => {
              console.log(`  ${icons[r.outcome]} ${(r.action ? `${r.tool} ${r.action}` : r.tool).padEnd(30)} ${r.reversibility.padEnd(12)} ${r.detail}`);
              for (const d of r.diffs.slice(0, 5)) console.log(c.dim(`        ${d.resource} ${d.path}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`));
            },
      });
      if (flags.json) console.log(JSON.stringify(report, null, 2));
      else {
        const s = report.summary;
        console.log(`\n  ${s.verified} verified · ${s.compensated} compensated · ${s.failed} failed · ${s.inconclusive} inconclusive · ${s.gated} gated · ${s.error} errors`);
        for (const line of report.cleanup) console.log(c.red(`  cleanup: ${line}`));
      }
      return report.summary.failed || report.summary.error || report.cleanup.length ? 1 : 0;
    }

    if (flags.undo) {
      const tools = (await listAllTools(upstream)) as McpTool[];
      const session = await ToolSession.open({
        call: async (name, args) => (await upstream.callTool({ name, arguments: args })) as never,
        plans: planTools(tools, overrides),
        store: new FileJournalStore<ToolEntry>(flags.journal!),
      });
      const selectors = [flags.seq !== undefined, !!flags.all, flags.after !== undefined, flags.session !== undefined].filter(Boolean).length;
      if (selectors > 1) throw new WrapUsageError('use one of --seq, --all, --after and --session');
      if (flags.session && !session.journal.some((e) => e.session === flags.session)) throw new WrapUsageError(`No entries for session ${flags.session} in ${flags.journal}`);
      let failedAny = false;
      const show = (e: ToolEntry) => console.log(c.green(`  ↺ #${e.seq} ${e.tool}  ${e.inverse?.tool ?? ''} ${JSON.stringify(e.inverse?.arguments ?? {})}`));
      if (flags.seq !== undefined) {
        const seq = Number(flags.seq);
        if (!Number.isInteger(seq)) throw new WrapUsageError('--seq must be a number');
        const undone: ToolEntry[] = [];
        try {
          await session.undo(seq, { force: flags.force, cascade: flags.cascade, undone });
        } catch (err) {
          console.log(c.red(`  ✗ ${(err as Error).message}`));
          failedAny = true;
        }
        undone.forEach(show); // the entry, and anything a cascade undid first
      } else {
        const after = flags.after !== undefined ? Number(flags.after) : undefined;
        if (after !== undefined && !Number.isInteger(after)) throw new WrapUsageError('--after must be a number');
        if (!flags.all && after === undefined && !flags.session) throw new WrapUsageError('wrap --undo needs --seq, --all, --after or --session');
        const { undone, failed } = await session.undoAll({ force: flags.force, cascade: flags.cascade, after, session: flags.session });
        undone.forEach(show);
        for (const f of failed) console.log(c.red(`  ✗ #${f.entry.seq} ${f.entry.tool}: ${f.error.message}`));
        if (!undone.length && !failed.length) console.log('  nothing to undo');
        failedAny = failed.length > 0;
      }
      return failedAny ? 1 : 0;
    }

    const { server, tools } = await createWrapServer({
      upstream,
      overrides,
      irreversible: mode as 'ask' | 'allow' | 'deny',
      store: flags.journal ? new FileJournalStore<ToolEntry>(flags.journal) : undefined,
    });
    await server.connect(new StdioServerTransport());
    console.error(`undogen wrap: serving ${upstream.getServerVersion()?.name ?? label} (${tools.length} tools) with undo over stdio`);
    // Stop when either side goes away: the client closing our stdin (the MCP stdio shutdown), a signal, the wrapped
    // server exiting, or a hosted server dropping our session (every later call would fail).
    await new Promise<void>((resolve) => {
      server.onclose = resolve;
      upstream.onclose = resolve;
      upstream.onerror = (err) => {
        if (err instanceof StreamableHTTPError && err.code === 404) {
          console.error(`undogen wrap: ${label} ended the session; stopping`);
          resolve();
        }
      };
      process.stdin.once('end', resolve);
      process.stdin.once('close', resolve);
      process.once('SIGTERM', resolve);
      process.once('SIGINT', resolve);
    });
    await server.close().catch(() => undefined);
    await http?.terminateSession().catch(() => undefined); // a hosted server can drop our session now, not at expiry
    await upstream.close().catch(() => undefined); // stops the wrapped server's process
    process.exit(0);
  } finally {
    await upstream.close().catch(() => undefined);
  }
}
