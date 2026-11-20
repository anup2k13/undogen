/** Public API descriptions used by plan-diff, audit-plans and the weekly workflow. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PUBLIC_SPECS: Record<string, string> = {
  github: 'https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json',
  stripe: 'https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json',
  twilio: 'https://raw.githubusercontent.com/twilio/twilio-oai/main/spec/json/twilio_api_v2010.json',
  asana: 'https://raw.githubusercontent.com/Asana/openapi/master/defs/asana_oas.yaml',
  slack: 'https://raw.githubusercontent.com/slackapi/slack-api-specs/master/web-api/slack_web_openapi_v2.json',
  kubernetes: 'https://raw.githubusercontent.com/kubernetes/kubernetes/master/api/openapi-spec/swagger.json',
};

/**
 * Specs split over many files (DigitalOcean: thousands of $ref files) can't be cached as one file:
 * they are loaded from their URL each time, so plan-diff and the audit still cover them.
 */
export const REMOTE_SPECS: Record<string, string> = {
  digitalocean: 'https://raw.githubusercontent.com/digitalocean/openapi/main/specification/DigitalOcean-public.v2.yaml',
};

export const fileFor = (name: string) => name + (PUBLIC_SPECS[name]!.endsWith('.yaml') ? '.yaml' : '.json');

/** Where to load an entry returned by ensureSpecs from: a cached file, or a remote spec's URL. */
export const specLocation = (dir: string, entry: string) => (/^https?:/.test(entry) ? entry : `${dir}/${entry}`);
/** The API name of an entry returned by ensureSpecs. */
export const specName = (entry: string) => (/^https?:/.test(entry) ? Object.keys(REMOTE_SPECS).find((k) => REMOTE_SPECS[k] === entry)! : entry.split('.')[0]!);

/** Download any spec missing from `dir` (or all of them with `refresh`). Returns the file names. */
export async function ensureSpecs(dir: string, refresh = false): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  for (const [name, url] of Object.entries(PUBLIC_SPECS)) {
    const file = join(dir, fileFor(name));
    if (existsSync(file) && !refresh) continue;
    console.error(`downloading ${name}…`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    writeFileSync(file, await res.text());
  }
  return [...Object.keys(PUBLIC_SPECS).map(fileFor), ...Object.values(REMOTE_SPECS)];
}
