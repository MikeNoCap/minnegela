#!/usr/bin/env node
import { Command } from 'commander';
import { credentials } from './config.js';
import { runImport } from './import.js';
import { login } from './login.js';
import { Api } from './api.js';

const log = (s: string) => process.stderr.write(`${s}\n`);
const program = new Command().name('minnegela').description('Minnegela command line: import folders the way the phone app syncs');

async function tokenFor(api: string, given?: string): Promise<string> {
  if (given) return given;
  if (process.env.MINNEGELA_TOKEN) return process.env.MINNEGELA_TOKEN;
  const c = (await credentials())[api.replace(/\/$/, '')];
  if (!c) throw new Error(`not logged in to ${api}; run: minnegela login ${api} you@example.com`);
  return c.token;
}

program.command('login').argument('<api>').argument('<email>').option('--url <magicLinkUrl>', 'skip the prompt and use this magic link')
  .action(async (api: string, email: string, opts: { url?: string }) => { await login(api, email, log, opts.url); log(`logged in to ${api} as ${email}`); });

program.command('whoami').option('--api <url>', 'API base', process.env.API_URL ?? 'http://localhost:4000').option('--token <t>')
  .action(async (opts: { api: string; token?: string }) => { console.log(JSON.stringify(await new Api(opts.api, await tokenFor(opts.api, opts.token)).me(), null, 2)); });

program.command('import').argument('<folder>')
  .requiredOption('--group <groupId>')
  .option('--api <url>', 'API base', process.env.API_URL ?? 'http://localhost:4000')
  .option('--token <t>', 'bearer session token (default: saved by `login` or $MINNEGELA_TOKEN)')
  .option('--device-name <name>', 'device name shown in the group', `cli:${process.env.HOSTNAME ?? 'folder'}`)
  .option('--originals', 'also upload originals', false)
  .option('--concurrency <n>', 'parallel uploads', (v) => Number(v), 4)
  .option('--dry-run', 'scan and show what would be sent', false)
  .option('--since <date>', 'only files modified since', (v) => new Date(v))
  .option('--ext <list>', 'comma-separated extensions (jpg,heic,mp4)', (v) => new Set(v.split(',').map((s) => s.trim().toLowerCase().replace(/^\./, ''))))
  .action(async (folder: string, opts: { group: string; api: string; token?: string; deviceName: string; originals: boolean; concurrency: number; dryRun: boolean; since?: Date; ext?: Set<string> }) => {
    const sum = await runImport({ api: opts.api, token: opts.dryRun ? '' : await tokenFor(opts.api, opts.token), group: opts.group, folder, deviceName: opts.deviceName, originals: opts.originals, concurrency: opts.concurrency, dryRun: opts.dryRun, since: opts.since, exts: opts.ext, log });
    if (sum.failed) process.exitCode = 1;
  });

program.parseAsync().catch((e) => { log(e instanceof Error ? e.message : String(e)); process.exit(1); });
