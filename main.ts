// main.ts — the entry <-> env lifecycle for the github-core-clone-01 forge.
//
// The forge is one process. In a trial it binds an ephemeral port, registers it with the
// env at $MAKEFUN_ENV_URL, then polls GET $MAKEFUN_ENV_URL/done until the suite is over
// and exits 0. Without MAKEFUN_ENV_URL (local testing) it just serves on a chosen port
// and logs it. Never binds 8080: the env owns it.

import { createApp } from './src/app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/** POST the bound port until the env accepts it (200) or reports a first register won (409). */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet: not done, poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

async function main(): Promise<void> {
  const server = createApp();
  if (ENV_URL === '') {
    // Local testing: no env to register with, just serve and log the port.
    const port = Number(process.env.PORT ?? 3000);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, () => resolve());
    });
    const address = server.address();
    const bound = address !== null && typeof address !== 'string' ? address.port : port;
    process.stdout.write(`[entry] local mode: listening on port ${bound} (no MAKEFUN_ENV_URL)\n`);
    // Stay up: the server is the process. Never return in local mode.
    await new Promise<void>(() => {});
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);
  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');
  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
