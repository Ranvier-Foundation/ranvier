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
export async function installWallets(page: Page, wallets: FakeWalletSpec[] = [DEFAULT_WALLET]) {
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
      const authorised = () => store('fake.auth') === '1';
      const provider = {
        async request({ method, params }: { method: string; params?: unknown[] }) {
          ctl.calls.push(method);
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
