/** Public API descriptions used by plan-diff, audit-plans and the weekly workflow. */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadSpec } from '../src/index.js';

export const PUBLIC_SPECS: Record<string, string> = {
  github: 'https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json',
  stripe: 'https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json',
  twilio: 'https://raw.githubusercontent.com/twilio/twilio-oai/main/spec/json/twilio_api_v2010.json',
  asana: 'https://raw.githubusercontent.com/Asana/openapi/master/defs/asana_oas.yaml',
  slack: 'https://raw.githubusercontent.com/slackapi/slack-api-specs/master/web-api/slack_web_openapi_v2.json',
  kubernetes: 'https://raw.githubusercontent.com/kubernetes/kubernetes/master/api/openapi-spec/swagger.json',
};

/**
 * Specs split over many files (DigitalOcean: thousands of $ref files). ensureSpecs mirrors every file the
 * loader fetches into `<dir>/<name>/`, keeping relative paths, so each run reads one consistent local copy.
 */
export const REMOTE_SPECS: Record<string, string> = {
  digitalocean: 'https://raw.githubusercontent.com/digitalocean/openapi/main/specification/DigitalOcean-public.v2.yaml',
};

export const fileFor = (name: string) => name + (PUBLIC_SPECS[name]!.endsWith('.yaml') ? '.yaml' : '.json');

/** Where to load an entry returned by ensureSpecs from. */
export const specLocation = (dir: string, entry: string) => join(dir, entry);
/** The API name of an entry returned by ensureSpecs ("github.json", "digitalocean/DigitalOcean-public.v2.yaml"). */
export const specName = (entry: string) => entry.split('/')[0]!.split('.')[0]!;

/**
 * Mirror a multi-file spec: load it from its URL once, saving every fetched document under its requested path
 * relative to the root's directory. Written to a temporary directory and moved into place only when the whole
 * spec loaded, so a failed download never leaves a partial copy that later runs would take for complete.
 */
async function mirror(url: string, out: string): Promise<void> {
  const base = new URL('./', url).href;
  const tmp = `${out}.partial`;
  rmSync(tmp, { recursive: true, force: true });
  try {
    await loadSpec(url, {
      // Follow redirects here (this is our own trusted list) so each document is saved under the URL that was asked for.
      fetch: async (u) => {
        const href = String(u);
        if (!href.startsWith(base)) throw new Error(`${href} is outside ${base}: it can't be mirrored`);
        const rel = decodeURIComponent(href.slice(base.length));
        if (rel.split('/').some((seg) => seg === '..' || seg === '.')) throw new Error(`${href}: unsafe path`);
        const res = await fetch(href);
        if (res.ok) {
          const file = join(tmp, rel);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, await res.clone().text());
        }
        return res;
      },
    });
    rmSync(out, { recursive: true, force: true });
    renameSync(tmp, out);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Download any spec missing from `dir` (or all of them with `refresh`). Returns entries relative to `dir`
 * (load one with specLocation(dir, entry), name it with specName(entry)) and the names of specs that could
 * not be downloaded, which callers must report: they are left out of the run.
 */
export async function ensureSpecs(dir: string, refresh = false): Promise<{ entries: string[]; failed: string[] }> {
  mkdirSync(dir, { recursive: true });
  for (const [name, url] of Object.entries(PUBLIC_SPECS)) {
    const file = join(dir, fileFor(name));
    if (existsSync(file) && !refresh) continue;
    console.error(`downloading ${name}…`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    writeFileSync(file, await res.text());
  }
  const remote: string[] = [];
  const failed: string[] = [];
  for (const [name, url] of Object.entries(REMOTE_SPECS)) {
    const root = url.slice(new URL('./', url).href.length);
    if (!existsSync(join(dir, name, root)) || refresh) {
      console.error(`downloading ${name} (many files)…`);
      try {
        await mirror(url, join(dir, name));
      } catch (err) {
        // A failed mirror leaves this spec out of the run (said loudly), not the others.
        console.error(`could not download ${name}: ${(err as Error).message}; it is left out of this run`);
        failed.push(name);
        continue;
      }
    }
    remote.push(`${name}/${root}`);
  }
  return { entries: [...Object.keys(PUBLIC_SPECS).map(fileFor), ...remote], failed };
}
