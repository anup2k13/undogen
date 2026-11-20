/** `undogen wrap [options] -- <command> [args...]` (experimental). */
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { c } from '../report.js';
import { FileJournalStore } from '../runtime.js';
import { VERSION } from '../version.js';
import { describePlan, planTools, type McpTool, type ToolOverrides } from './plans.js';
import { createWrapServer, listAllTools } from './server.js';
import { ToolSession, type ToolEntry } from './session.js';

export interface WrapFlags {
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
}

export class WrapUsageError extends Error {}

/** Connect to the server to wrap, started with the command after `--`. */
async function connectUpstream(command: string[]): Promise<Client> {
  const [cmd, ...args] = command;
  if (!cmd) throw new WrapUsageError('wrap needs the server to wrap after --, e.g. undogen wrap -- npx -y @acme/mcp-server');
  const upstream = new Client({ name: 'undogen-wrap', version: VERSION });
  // The wrapped server gets this process's environment (it usually needs a token from it); its stderr is ours.
  await upstream.connect(new StdioClientTransport({ command: cmd, args, env: process.env as Record<string, string>, stderr: 'inherit' }));
  return upstream;
}

export async function runWrap(flags: WrapFlags, command: string[]): Promise<number> {
  const mode = flags.irreversible ?? 'ask';
  if (!['ask', 'allow', 'deny'].includes(mode)) throw new WrapUsageError('--irreversible must be ask, allow or deny');
  const overrides = flags.overrides ? (JSON.parse(await readFile(flags.overrides, 'utf8')) as ToolOverrides) : undefined;
  if (flags.undo && !flags.journal) throw new WrapUsageError('wrap --undo needs --journal <file>');
  const upstream = await connectUpstream(command);

  try {
    if (flags.analyze) {
      const plans = planTools((await listAllTools(upstream)) as McpTool[], overrides);
      if (flags.json) {
        console.log(JSON.stringify(plans, null, 2));
        return 0;
      }
      const w = Math.max(...plans.map((p) => p.tool.length));
      const color = { reversible: c.green, compensable: c.yellow, irreversible: c.magenta, unknown: c.dim } as const;
      for (const p of plans) {
        const label = p.strategy === 'no-side-effects' ? c.dim('read-only'.padEnd(12)) : color[p.reversibility](p.reversibility.padEnd(12));
        console.log(`  ${p.tool.padEnd(w)}  ${label} ${c.dim(describePlan(p))}`);
      }
      const count = (r: string) => plans.filter((p) => p.reversibility === r && p.strategy !== 'no-side-effects').length;
      const reads = plans.filter((p) => p.strategy === 'no-side-effects').length;
      console.log(`\n  ${plans.length} tools: ${reads} read-only · ${count('reversible')} reversible · ${count('compensable')} compensable · ${count('irreversible')} irreversible · ${count('unknown')} unknown`);
      return 0;
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
        try {
          show(await session.undo(seq, { force: flags.force }));
        } catch (err) {
          console.log(c.red(`  ✗ ${(err as Error).message}`));
          failedAny = true;
        }
      } else {
        const after = flags.after !== undefined ? Number(flags.after) : undefined;
        if (after !== undefined && !Number.isInteger(after)) throw new WrapUsageError('--after must be a number');
        if (!flags.all && after === undefined && !flags.session) throw new WrapUsageError('wrap --undo needs --seq, --all, --after or --session');
        const { undone, failed } = await session.undoAll({ force: flags.force, after, session: flags.session });
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
    console.error(`undogen wrap: serving ${upstream.getServerVersion()?.name ?? command[0]} (${tools.length} tools) with undo over stdio`);
    // Stop when either side goes away.
    await new Promise<void>((resolve) => {
      server.onclose = resolve;
      upstream.onclose = resolve;
    });
    return 0;
  } finally {
    await upstream.close().catch(() => undefined);
  }
}
