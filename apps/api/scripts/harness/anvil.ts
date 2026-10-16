/**
 * LOCAL TEST HARNESS ONLY (ADR 0013). Never imported by `src/`.
 *
 * Starts a plain anvil (chain 31337, 127.0.0.1, a free ephemeral port, never 3000), deploys the
 * harness with `DeployHarness.s.sol` exactly as the runbook does (`--unlocked --sender`, so no key
 * is passed anywhere), and stops that anvil by its own child handle (the exact PID it started).
 * It never kills a process by name or pattern, and never one it did not start.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'viem';
import { devAccounts } from './dev-accounts.js';
import { FEE_WRAPPER_SALT, HARNESS_CHAIN_ID } from './pinned.js';
import { assertLoopbackRpcUrl, verifyLocalChain } from './rpc-guard.js';

export interface Foundry {
  anvil: string;
  forge: string;
}

const CONTRACTS_DIR = fileURLToPath(new URL('../../../../contracts/', import.meta.url));

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** anvil and forge from PATH, else from ~/.foundry/bin; undefined when either is missing. */
export function findFoundry(env: NodeJS.ProcessEnv = process.env): Foundry | undefined {
  const dirs = [
    ...(env.PATH ?? '').split(delimiter).filter(Boolean),
    join(homedir(), '.foundry', 'bin'),
  ];
  const find = (name: string): string | undefined =>
    dirs.map((d) => join(d, name)).find((p) => executable(p));
  const anvil = find('anvil');
  const forge = find('forge');
  return anvil && forge ? { anvil, forge } : undefined;
}

/** A free TCP port on 127.0.0.1, chosen by the OS; never 3000 (the owner's dev server). */
export async function freeLoopbackPort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port: p } = server.address() as AddressInfo;
        server.close(() => resolve(p));
      });
    });
    if (port !== 3000) return port;
  }
}

/** The minimal environment for Foundry children: nothing inherited from the shell but these. */
function foundryEnv(foundry: Foundry, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: [join(foundry.forge, '..'), process.env.PATH ?? ''].join(delimiter),
    HOME: homedir(),
    ...extra,
  };
}

export interface AnvilHandle {
  url: string;
  pid: number;
  stop(): Promise<void>;
}

function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Starts anvil on 127.0.0.1:<port>, chain 31337, and waits until it answers 31337. */
export async function startAnvil(foundry: Foundry, port: number): Promise<AnvilHandle> {
  const url = assertLoopbackRpcUrl(`http://127.0.0.1:${port}`);
  const child = spawn(
    foundry.anvil,
    [
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--chain-id',
      String(HARNESS_CHAIN_ID),
      '--silent',
    ],
    { env: foundryEnv(foundry), stdio: 'ignore' },
  );
  const pid = child.pid;
  if (pid === undefined) throw new Error('anvil did not start');
  const stop = async (): Promise<void> => {
    // Only this child, by its own handle (exact PID); SIGKILL if it ignores SIGTERM.
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    if (!(await waitExit(child, 5_000))) {
      child.kill('SIGKILL');
      await waitExit(child, 5_000);
    }
  };
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`anvil exited with code ${child.exitCode}`);
    try {
      await verifyLocalChain(url, { timeoutMs: 1_000 });
      return { url, pid, stop };
    } catch (err: unknown) {
      if (Date.now() > deadline) {
        await stop();
        throw err;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/**
 * Runs `DeployHarness.s.sol` against `url` as anvil account 0 (`--unlocked --sender`), with the
 * runbook's roles: owner and guardian account 0, collector account 3, fee signer account 1, and no
 * INITIAL_ROUTERS (the harness allowlists its own holder). Loopback and chain 31337 are checked
 * before forge runs, because Solidity cannot see `--rpc-url`.
 */
export async function deployHarness(foundry: Foundry, rawUrl: string): Promise<void> {
  const url = assertLoopbackRpcUrl(rawUrl);
  await verifyLocalChain(url);
  const accounts = devAccounts();
  const deployer = getAddress(accounts.deployer);
  const env = foundryEnv(foundry, {
    FEE_WRAPPER_SALT,
    ADMIN_ADDRESS: deployer,
    GUARDIAN_ADDRESS: deployer,
    FEE_COLLECTOR: getAddress(accounts.collector),
    FEE_SIGNER: getAddress(accounts.feeSigner.address),
  });
  const args = [
    'script',
    'test/harness/DeployHarness.s.sol',
    '--rpc-url',
    url,
    '--broadcast',
    '--unlocked',
    '--sender',
    deployer,
  ];
  await new Promise<void>((resolve, reject) => {
    execFile(
      foundry.forge,
      args,
      { cwd: CONTRACTS_DIR, env, timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const tail = `${stdout}\n${stderr}`.trim().split('\n').slice(-20).join('\n');
          reject(new Error(`DeployHarness.s.sol failed:\n${tail}`));
        } else {
          resolve();
        }
      },
    );
  });
}
