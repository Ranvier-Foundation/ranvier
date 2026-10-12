import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Header } from '../../src/components/header';
import { Logo } from '../../src/components/logo';
import { SwapPanel } from '../../src/components/swap-panel';

describe('Header', () => {
  it('signed out: Connect wallet is a button and the Activity badge is hidden at zero', () => {
    const html = renderToStaticMarkup(<Header active="swap" />);
    expect(html).toContain('<button type="button" class="flex h-control');
    expect(html).toContain('Connect wallet');
    expect(html).not.toContain('swap in progress');
    expect(html).not.toContain('rounded-pill bg-accent');
  });

  it('shows the badge and reads it as part of the link label', () => {
    const html = renderToStaticMarkup(<Header activityCount={1} />);
    expect(html).toContain('aria-label="Activity, 1 swap in progress"');
    expect(renderToStaticMarkup(<Header activityCount={2} />)).toContain(
      'Activity, 2 swaps in progress',
    );
  });

  it('marks only the active tab', () => {
    const html = renderToStaticMarkup(<Header active="buy" />);
    expect(html.match(/aria-current="page"/g)).toHaveLength(2); // top nav and menu copy
    expect(renderToStaticMarkup(<Header active="none" />)).not.toContain('aria-current');
  });

  it('connected: shows the wallet pill instead of Connect wallet', () => {
    const html = renderToStaticMarkup(
      <Header wallet={{ address: '0x7a3E00000000000000000000000000000000' + '3F9c' }} />,
    );
    expect(html).toContain('Wallet 0x7a3E…3F9c');
    expect(html).not.toContain('Connect wallet');
  });

  it('defaults the network to the first registry chain, and supports all networks', () => {
    expect(renderToStaticMarkup(<Header />)).toContain('aria-label="Network: Ethereum"');
    expect(renderToStaticMarkup(<Header network="all" />)).toContain(
      'aria-label="Network: All networks"',
    );
  });
});

describe('Logo and panel', () => {
  it('renders the 32 px logo with the table geometry', () => {
    const html = renderToStaticMarkup(<Logo size={32} />);
    expect(html).toContain('font-size:32px');
    expect(html).toContain('width:14px;height:14px;margin-bottom:8px;margin-left:3px');
    expect(html).toContain('left:0;top:8px;width:6px;height:6px');
    expect(html).toContain('left:8px;top:0;width:6px;height:6px');
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
