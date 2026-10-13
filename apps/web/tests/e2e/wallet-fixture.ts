import type { Page } from '@playwright/test';

/** A 1x1 PNG, base64, as an EIP-6963 icon. */
export const ICON_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==';

export const ACCOUNT_A = '0x7a3E1b2C9d4F5a60718293a4B5c6D7e8F9013F9c';
export const ACCOUNT_B = '0x1111111111111111111111111111111111112222';

export interface FakeWalletSpec {
  name: string;
  rdns: string;
  uuid?: string;
  icon?: string;
}

export const DEFAULT_WALLET: FakeWalletSpec = {
  name: 'Fixture Wallet',
  rdns: 'test.fixture.wallet',
  icon: ICON_PNG,
};

/** Hex chain ids the fake wallet already knows; anything else answers 4902 on switch. */
export const KNOWN_CHAINS = ['0x1', '0x2105', '0xa4b1', '0x89'];

/** What the page-side controller exposes to tests through `window.__fake`. */
export interface FakeController {
  accounts: string[];
  chainId: string;
  /** Next eth_requestAccounts: 'ok', 'reject' (4001), 'pending' (-32002) or 'fail' (-32603). */
  connect: 'ok' | 'reject' | 'pending' | 'fail';
  /** Next wallet_switchEthereumChain: 'ok', 'reject' (4001). */
  switch: 'ok' | 'reject';
  /** Hex chain ids the wallet does not know (switching answers 4902). */
  unknown: string[];
  calls: string[];
}

/**
 * Injects fake EIP-1193 providers announced over EIP-6963 before any page script runs. Authorisation
 * survives reloads through sessionStorage (like a real wallet remembering the site).
 */
const recorded = new WeakMap<Page, string[]>();

/** Every JSON-RPC method the page asked a fake wallet, across reloads (kept on the test side). */
export function walletCalls(page: Page): readonly string[] {
  return recorded.get(page) ?? [];
}

/**
 * The only methods this change may send to a wallet: connect, read the account and chain, revoke
 * permissions on disconnect, and switch or add a network. Anything else (signing, sending,
 * reading the chain through the wallet, or any legacy `send`, `sendAsync` or `enable` call, which
 * are recorded with a `legacy:` prefix) fails the test.
 */
export const ALLOWED_WALLET_METHODS: ReadonlySet<string> = new Set([
  'eth_accounts',
  'eth_chainId',
  'eth_requestAccounts',
  'wallet_requestPermissions',
  'wallet_revokePermissions',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
]);

/**
 * Calls the wallet received that are not on the allowlist. Waits a moment first: the page reports
 * each call through an asynchronous binding, so the last one may still be in flight.
 */
export async function unexpectedWalletCalls(page: Page): Promise<string[]> {
  try {
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
  } catch {
    /* page already closed: use what was recorded */
  }
  return walletCalls(page).filter((m) => !ALLOWED_WALLET_METHODS.has(m));
}

/** Clears the log (only for the negative test that proves the allowlist check works). */
export function forgetWalletCalls(page: Page): void {
  recorded.get(page)?.splice(0);
}

/** Records calls from every fake provider on this page; safe to call more than once. */
async function trackCalls(page: Page): Promise<void> {
  if (recorded.has(page)) return;
  const log: string[] = [];
  recorded.set(page, log);
  await page.exposeFunction('__recordCall', (method: string) => {
    log.push(method);
  });
}

export async function installWallets(page: Page, wallets: FakeWalletSpec[] = [DEFAULT_WALLET]) {
  await trackCalls(page);
  await page.addInitScript(
    ({ wallets, accountA, known }) => {
      const w = window as unknown as Record<string, unknown>;
      const store = (key: string, value?: string) => {
        try {
          if (value === undefined) return sessionStorage.getItem(key);
          sessionStorage.setItem(key, value);
        } catch {
          /* ignore */
        }
        return null;
      };
      const ctl = {
        accounts: [accountA],
        chainId: store('fake.chain') ?? '0x1',
        connect: 'ok',
        switch: 'ok',
        unknown: [] as string[],
        calls: [] as string[],
      };
      w.__fake = ctl;
      const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
      const emit = (event: string, ...args: unknown[]) =>
        (listeners[event] ?? []).slice().forEach((fn) => fn(...args));
      w.__emit = emit;
      const err = (code: number, message: string) => Object.assign(new Error(message), { code });
      const report = (method: string) => {
        ctl.calls.push(method);
        (w.__recordCall as ((m: string) => void) | undefined)?.(method);
      };
      w.__fakeProvider = () => provider;
      const authorised = () => store('fake.auth') === '1';
      const provider = {
        async request({ method, params }: { method: string; params?: unknown[] }) {
          report(method);
          switch (method) {
            case 'eth_requestAccounts':
              if (ctl.connect === 'reject') throw err(4001, 'User rejected the request.');
              if (ctl.connect === 'pending') throw err(-32002, 'Request already pending.');
              if (ctl.connect === 'fail') throw err(-32603, 'boom');
              store('fake.auth', '1');
              return ctl.accounts;
            case 'eth_accounts':
              return authorised() ? ctl.accounts : [];
            case 'eth_chainId':
              return ctl.chainId;
            case 'wallet_switchEthereumChain': {
              const target = (params?.[0] as { chainId: string }).chainId;
              if (ctl.switch === 'reject') throw err(4001, 'User rejected the request.');
              if (!known.includes(target) || ctl.unknown.includes(target))
                throw err(4902, 'Unrecognized chain ID.');
              ctl.chainId = target;
              store('fake.chain', target);
              emit('chainChanged', target);
              return null;
            }
            case 'wallet_revokePermissions':
              store('fake.auth', '0');
              return null;
            case 'wallet_requestPermissions':
              return [];
            default:
              throw err(4200, `Unsupported method ${method}`);
          }
        },
        // Legacy entry points: never used by this app. Recorded with a `legacy:` prefix so any
        // call shows up as unexpected.
        send(method: unknown) {
          report(`legacy:send:${typeof method === 'string' ? method : 'payload'}`);
          return Promise.reject(err(4200, 'send is not supported'));
        },
        sendAsync(payload: { method?: string }, cb?: (e: Error) => void) {
          report(`legacy:sendAsync:${payload?.method ?? 'payload'}`);
          cb?.(err(4200, 'sendAsync is not supported'));
        },
        enable() {
          report('legacy:enable');
          return Promise.reject(err(4200, 'enable is not supported'));
        },
        on(event: string, fn: (...a: unknown[]) => void) {
          (listeners[event] ??= []).push(fn);
        },
        removeListener(event: string, fn: (...a: unknown[]) => void) {
          listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn);
        },
      };
      const announce = () => {
        for (const [i, spec] of wallets.entries()) {
          window.dispatchEvent(
            new CustomEvent('eip6963:announceProvider', {
              detail: Object.freeze({
                info: Object.freeze({
                  uuid: spec.uuid ?? `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
                  name: spec.name,
                  icon: spec.icon ?? '',
                  rdns: spec.rdns,
                }),
                provider,
              }),
            }),
          );
        }
      };
      window.addEventListener('eip6963:requestProvider', announce);
      announce();
    },
    { wallets, accountA: ACCOUNT_A, known: KNOWN_CHAINS },
  );
}

/** Runs a function against `window` (the fake wallet's controller and emitter) inside the page. */
export async function fake<T>(
  page: Page,
  fn: (w: Window & { __fake: FakeController; __emit: (e: string, ...a: unknown[]) => void }) => T,
): Promise<T> {
  return page.evaluate(
    (src) => (new Function('w', `return (${src})(w)`) as (w: Window) => T)(window),
    fn.toString(),
  );
}

/**
 * Announces wallets whose fields are objects that change between reads (a `toString` that first
 * returns a data URI and then an https URL, a getter that flips, a Proxy). A sanitiser that
 * checks one read and uses another would render the second.
 */
export async function installHostileAnnouncements(page: Page) {
  await trackCalls(page);
  await page.addInitScript(
    ({ png }) => {
      const flip = (first: string, later: string) => {
        let n = 0;
        return { length: 10, toString: () => (n++ === 0 ? first : later), valueOf: () => later };
      };
      const report = (method: string) =>
        (window as unknown as { __recordCall?: (m: string) => void }).__recordCall?.(method);
      const refuse = () => Object.assign(new Error('no'), { code: 4200 });
      const provider = {
        request: async ({ method }: { method: string }) => {
          report(method);
          throw refuse();
        },
        send: (method: string) => {
          report(`legacy:send:${method}`);
          return Promise.reject(refuse());
        },
        sendAsync: (payload: { method?: string }) => report(`legacy:sendAsync:${payload?.method}`),
        enable: () => {
          report('legacy:enable');
          return Promise.reject(refuse());
        },
        on() {},
        removeListener() {},
      };
      const announce = (info: Record<string, unknown>) =>
        window.dispatchEvent(
          new CustomEvent('eip6963:announceProvider', { detail: { info, provider } }),
        );
      const run = () => {
        announce({
          uuid: '00000000-0000-4000-8000-0000000000a1',
          name: 'Flip Icon',
          rdns: 'flip.icon',
          icon: flip(png, 'https://evil.example/steal.png'),
        });
        let reads = 0;
        announce({
          uuid: '00000000-0000-4000-8000-0000000000a2',
          name: 'Getter Icon',
          rdns: 'getter.icon',
          get icon() {
            return reads++ === 0 ? png : 'https://evil.example/getter.png';
          },
        });
        announce({
          uuid: '00000000-0000-4000-8000-0000000000a3',
          name: flip('Flip Name', 'https://evil.example/name'),
          rdns: flip('flip.name', 'evil.rdns'),
          icon: png,
        });
        announce({
          uuid: '00000000-0000-4000-8000-0000000000a4',
          name: 'Proxy Icon',
          rdns: 'proxy.icon',
          icon: new Proxy(
            {},
            {
              get: (_t, key) =>
                key === 'length'
                  ? 10
                  : key === Symbol.toPrimitive
                    ? () => 'https://evil.example/proxy.png'
                    : undefined,
            },
          ),
        });
        announce({
          uuid: '00000000-0000-4000-8000-0000000000a5',
          name: new String('Boxed Name'),
          rdns: 'boxed.name',
          icon: new String(png),
        });
        announce({
          uuid: '00000000-0000-4000-8000-0000000000a6',
          name: 'Plain Good',
          rdns: 'plain.good',
          icon: png,
        });
      };
      window.addEventListener('eip6963:requestProvider', run);
      run();
    },
    { png: ICON_PNG },
  );
}
