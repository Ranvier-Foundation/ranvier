import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TokenRow } from '../../src/components/token-row';
import type { ApiChain, ApiToken } from '../../src/lib/api/schemas';
import type { PickerRow } from '../../src/lib/picker/model';

const chain: ApiChain = {
  key: 'evm:8453',
  name: 'Base',
  family: 'evm',
  nativeSymbol: 'ETH',
  balances: true,
};
const row = (token: Partial<ApiToken>): PickerRow => ({
  key: 'k',
  chain,
  balance: { state: 'unknown' },
  token: {
    chain: chain.key,
    address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    tags: [],
    ...token,
  },
});
const render = (r: PickerRow, showAddress?: boolean) =>
  renderToStaticMarkup(
    <TokenRow
      row={r}
      id="o"
      active={false}
      {...(showAddress === undefined ? {} : { showAddress })}
      onPick={() => {}}
    />,
  );

describe('TokenRow short address', () => {
  it('is hidden unless another listed token shares the symbol', () => {
    const html = render(row({}));
    expect(html).not.toContain('0x8335');
    expect(html).toContain('aria-label="USDC, USD Coin, Base"');
  });
  it('shows 0x1234…abcd as text after the chain, and in the accessible name', () => {
    const html = render(row({}), true);
    expect(html).toContain('<span class="addr shrink-0">· 0x8335…2913</span>');
    expect(html).toContain('aria-label="USDC, USD Coin, Base, address 0x8335…2913"');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href');
  });
  it('shows nothing for a native coin, which has no address', () => {
    const html = render(row({ address: 'native', symbol: 'ETH', name: 'Ether' }), true);
    expect(html).not.toContain('addr');
    expect(html).not.toContain('address');
  });
});
