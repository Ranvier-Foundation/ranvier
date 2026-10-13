import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Header } from '../../src/components/header';
import { Logo } from '../../src/components/logo';
import { SwapCta } from '../../src/components/swap-cta';
import { SwapPanel } from '../../src/components/swap-panel';
import { WalletProviders } from '../../src/components/wallet-providers';

const render = (node: React.ReactElement) =>
  renderToStaticMarkup(<WalletProviders>{node}</WalletProviders>);

describe('Header', () => {
  it('signed out: Connect wallet is a button and the Activity badge is hidden at zero', () => {
    const html = render(<Header active="swap" />);
    expect(html).toContain('<button type="button" class="flex h-control');
    expect(html).toContain('Connect wallet');
    expect(html).not.toContain('swap in progress');
    expect(html).not.toContain('rounded-pill bg-accent');
  });

  it('shows the badge and reads it as part of the link label', () => {
    const html = render(<Header activityCount={1} />);
    expect(html).toContain('aria-label="Activity, 1 swap in progress"');
    expect(render(<Header activityCount={2} />)).toContain('Activity, 2 swaps in progress');
  });

  it('marks only the active tab', () => {
    const html = render(<Header active="buy" />);
    expect(html.match(/aria-current="page"/g)).toHaveLength(2); // top nav and menu copy
    expect(render(<Header active="none" />)).not.toContain('aria-current');
  });

  it('signed out: shows the default network from the registry, no wallet address', () => {
    const html = render(<Header />);
    expect(html).toContain('aria-label="Network: Ethereum"');
    expect(html).not.toContain('0x');
  });
});

describe('Swap CTA', () => {
  it('signed out it is the Connect wallet button', () => {
    const html = render(<SwapCta />);
    expect(html).toContain('Connect wallet');
    expect(html).not.toContain('disabled');
  });
});

describe('Logo and panel', () => {
  it('renders the 32 px logo with the table geometry', () => {
    const html = renderToStaticMarkup(<Logo size={32} />);
    // The geometry is tokens + classes now (checked against the table in logo.test.tsx and as
    // computed pixels in the e2e header tests); the markup carries no inline style.
    expect(html).toContain('logo-32');
    expect(html).toContain('logo-square-low');
    expect(html).toContain('logo-square-high');
    expect(html).not.toContain('style=');
  });

  it('swap panel starts empty with no invented numbers', () => {
    const html = renderToStaticMarkup(<SwapPanel />);
    expect(html).toContain('Pay on');
    expect(html).toContain('Receive on');
    expect(html).toContain('placeholder="0"');
    expect(html).toContain('$0.00');
    expect(html).not.toMatch(/%/);
  });
});
