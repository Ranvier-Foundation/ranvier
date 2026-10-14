'use client';

import { useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useConnection } from 'wagmi';
import type { TokenRef } from '@ranvier/types';
import { chainBg } from '@/lib/chain-style';
import { t, tPlural } from '@/lib/i18n';
import { buildRows, quickPicks, splitSections, type PickerRow } from '@/lib/picker/model';
import { MAX_QUERY_LENGTH } from '@/lib/picker/search';
import { useTokenPicker, type Selection } from '@/lib/picker/use-token-picker';
import { Chip } from './chip';
import { SearchIcon } from './icons';
import { Modal } from './modal';
import { TokenAvatar } from './token-avatar';
import { TokenRow, TokenRowsSkeleton } from './token-row';

const SKELETON_ROWS = 6;
const SKELETON_CHIPS = 4;

export interface TokenPickerProps {
  /** The caller gets the chosen token as `{ chain, address }`, nothing else (spec section 14). */
  onSelect: (token: TokenRef) => void;
  /** Escape, the close button, a click on the scrim. The caller unmounts the picker. */
  onClose: () => void;
}

const listFormat = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="mx-24 my-16 bg-danger-tint p-12 text-danger-text max-narrow:mx-16">
      <p className="m-0 text-small leading-body">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-8 flex h-control items-center rounded-pill border border-danger-text px-18 text-body font-medium transition hover:bg-hover"
        >
          {t('picker.retry')}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Select token (canvas: WebTokenSelect, MobileTokenSelect). A modal with a search field, chain
 * filter chips, quick picks and a listbox of tokens, from the Ranvier API only. The search field
 * is a combobox: focus stays in it and the arrow keys move the active option. Balances belong to
 * the connected wallet and are display only; a failed balance read never hides the token list.
 */
export function TokenPicker({ onSelect, onClose }: TokenPickerProps) {
  const { status, address } = useConnection();
  const walletAddress = status === 'connected' ? address : undefined;
  const walletPending = status === 'connecting' || status === 'reconnecting';
  const data = useTokenPicker(walletAddress);
  const { chains, tokens, balances, selection, query } = data;
  const [activeIndex, setActiveIndex] = useState(-1);
  const ids = useId();
  const listId = `${ids}-list`;
  const optionId = (i: number) => `${ids}-option-${i}`;

  const chainList = chains.status === 'ready' ? chains.chains : [];
  const rows = useMemo(
    () =>
      tokens.status === 'ready' ? buildRows(tokens.tokens, chainList, balances, walletAddress) : [],
    [tokens, chains, balances, walletAddress],
  );
  const sections = useMemo(() => splitSections(rows), [rows]);
  const flat = useMemo(() => [...sections.held, ...sections.other], [sections]);

  // Rows change under the cursor (search, chain switch, balances arriving): drop the highlight.
  useEffect(() => setActiveIndex(-1), [tokens, selection]);
  useEffect(() => {
    if (activeIndex >= 0) {
      document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  const pick = (row: PickerRow) => onSelect({ chain: row.token.chain, address: row.token.address });

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (flat.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      const row = flat[activeIndex];
      if (row) {
        e.preventDefault();
        pick(row);
      }
    }
  }

  const showList = tokens.status === 'ready' && flat.length > 0;
  const quick =
    selection !== 'all' && query.trim() === '' && tokens.status === 'ready'
      ? quickPicks(tokens.tokens)
      : [];
  const chainName = (key: string) => chainList.find((c) => c.key === key)?.name ?? key;

  const groups: { id: string; label: string; rows: PickerRow[]; offset: number }[] = [];
  if (sections.held.length > 0) {
    groups.push({ id: 'held', label: t('picker.section.held'), rows: sections.held, offset: 0 });
  }
  if (sections.other.length > 0) {
    groups.push({
      id: 'other',
      label: t(sections.held.length > 0 ? 'picker.section.other' : 'picker.section.all'),
      rows: sections.other,
      offset: sections.held.length,
    });
  }

  let statusText = '';
  if (tokens.status === 'loading') statusText = t('picker.loading');
  else if (tokens.status === 'ready') {
    statusText =
      flat.length === 0 ? t('picker.status.empty') : tPlural('picker.count', flat.length);
  }

  return (
    <Modal
      variant="picker"
      titleId={`${ids}-title`}
      title={t('picker.title')}
      closeLabel={t('picker.close')}
      onClose={onClose}
      focusMarked
    >
      <div className="shrink-0 border-b border-line px-24 pb-14 max-narrow:border-b-0 max-narrow:px-16 max-narrow:pb-0">
        <label className="search-field flex h-52 items-center gap-10 rounded-pill bg-bg px-16 text-sub max-narrow:h-48">
          <SearchIcon />
          <input
            type="text"
            role="combobox"
            aria-label={t('picker.search.label')}
            aria-autocomplete="list"
            aria-expanded={showList}
            {...(showList ? { 'aria-controls': listId } : {})}
            {...(activeIndex >= 0 ? { 'aria-activedescendant': optionId(activeIndex) } : {})}
            data-initial-focus=""
            value={query}
            maxLength={MAX_QUERY_LENGTH}
            placeholder={t('picker.search.placeholder')}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="go"
            onChange={(e) => data.setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            className="min-w-0 flex-1 border-none bg-transparent text-lead text-ink placeholder:text-sub"
          />
        </label>

        <div
          role="group"
          aria-label={t('picker.chains.label')}
          aria-busy={chains.status === 'loading'}
          className="mt-14 flex flex-wrap gap-6 max-narrow:mt-12 max-narrow:flex-nowrap max-narrow:overflow-x-auto max-narrow:pb-4"
        >
          {chains.status === 'ready' ? (
            <>
              <ChainChip selected={selection === 'all'} onClick={() => data.setSelection('all')}>
                <span
                  aria-hidden="true"
                  className="chain-all-dot size-14 rounded-round max-narrow:hidden"
                />
                {t('picker.chain.all')}
              </ChainChip>
              {chainList.map((chain) => (
                <ChainChip
                  key={chain.key}
                  selected={selection === chain.key}
                  onClick={() => data.setSelection(chain.key as Selection)}
                >
                  <span
                    aria-hidden="true"
                    className={`size-14 rounded-round max-narrow:hidden ${chainBg(chain.key)}`}
                  />
                  {chain.name}
                </ChainChip>
              ))}
            </>
          ) : chains.status === 'loading' ? (
            <>
              <span className="sr-only">{t('picker.chains.loading')}</span>
              {Array.from({ length: SKELETON_CHIPS }, (_, i) => (
                <span
                  key={i}
                  aria-hidden="true"
                  className="h-36 w-88 shrink-0 rounded-pill bg-pill"
                />
              ))}
            </>
          ) : null}
        </div>

        {quick.length > 0 ? (
          <div
            role="group"
            aria-label={t('picker.quick.label')}
            className="mt-14 flex flex-wrap gap-6 max-narrow:hidden"
          >
            {quick.map((token) => (
              <Chip
                key={token.address}
                variant="token"
                aria-label={t('picker.quick.token', {
                  symbol: token.symbol,
                  chain: chainName(token.chain),
                })}
                onClick={() => onSelect({ chain: token.chain, address: token.address })}
              >
                <TokenAvatar symbol={token.symbol} size="sm" />
                {token.symbol}
              </Chip>
            ))}
          </div>
        ) : null}
      </div>

      <p role="status" className="sr-only">
        {statusText}
      </p>

      {/* Focusable so a keyboard user can scroll it (WCAG 2.1.1); options are reached with the arrow keys from the search field. */}
      <div
        role="region"
        aria-label={t('picker.region.label')}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto focus-visible:-outline-offset-2"
      >
        {chains.status === 'error' ? (
          <ErrorBox
            message={t(
              chains.kind === 'unconfigured' ? 'picker.error.unconfigured' : 'picker.error.tokens',
            )}
            {...(chains.kind === 'unconfigured' ? {} : { onRetry: data.retryChains })}
          />
        ) : tokens.status === 'error' ? (
          <ErrorBox message={t('picker.error.tokens')} onRetry={data.retryTokens} />
        ) : tokens.status === 'loading' || chains.status === 'loading' ? (
          <TokenRowsSkeleton count={SKELETON_ROWS} />
        ) : flat.length === 0 ? (
          <p className="m-0 p-24 text-center text-small text-sub">{t('picker.empty')}</p>
        ) : (
          <div id={listId} role="listbox" aria-label={t('picker.list.label')} className="pb-4">
            {groups.map((group) => (
              <div
                key={group.id}
                role="group"
                aria-labelledby={`${ids}-group-${group.id}`}
                className="px-12 max-narrow:px-8"
              >
                <div
                  id={`${ids}-group-${group.id}`}
                  className="px-12 pt-14 pb-6 text-caption font-medium text-sub max-narrow:pb-4"
                >
                  {group.label}
                </div>
                {group.rows.map((row, i) => (
                  <TokenRow
                    key={row.key}
                    row={row}
                    id={optionId(group.offset + i)}
                    active={activeIndex === group.offset + i}
                    onPick={pick}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      <BalanceNotes
        walletAddress={walletAddress}
        walletPending={walletPending}
        chainsReady={chains.status === 'ready'}
        selection={selection}
        chainList={chainList}
        balances={balances}
        onRetry={data.retryBalances}
      />
    </Modal>
  );
}

function ChainChip({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Chip selected={selected} onClick={onClick}>
      {children}
    </Chip>
  );
}

/**
 * The footer band (canvas: grey strip under the list): what the screen cannot show about balances.
 * A failed or unavailable balance read says so and the token list stays usable.
 */
function BalanceNotes({
  walletAddress,
  walletPending,
  chainsReady,
  selection,
  chainList,
  balances,
  onRetry,
}: {
  walletAddress: string | undefined;
  walletPending: boolean;
  chainsReady: boolean;
  selection: Selection;
  chainList: readonly { key: string; name: string }[];
  balances: ReadonlyMap<string, { status: string }>;
  onRetry: () => void;
}) {
  if (!chainsReady || walletPending) return null;
  const shown = selection === 'all' ? chainList : chainList.filter((c) => c.key === selection);
  const names = (status: string) =>
    listFormat.format(
      shown.filter((c) => balances.get(c.key)?.status === status).map((c) => c.name),
    );
  const failed = names('error');
  const unavailable = names('unavailable');
  const loading = shown.some((c) => {
    const s = balances.get(c.key)?.status;
    return s === undefined || s === 'loading';
  });

  const notes: string[] = [];
  if (walletAddress === undefined) notes.push(t('picker.wallet.connect'));
  else {
    if (failed) notes.push(t('picker.balances.error', { chains: failed }));
    if (unavailable) notes.push(t('picker.balances.unavailable', { chains: unavailable }));
    if (notes.length === 0 && loading) notes.push(t('picker.balances.loading'));
  }
  if (notes.length === 0) return null;
  return (
    <div className="mt-8 flex shrink-0 items-center justify-between gap-12 bg-bg px-24 py-14 text-caption text-sub max-narrow:px-20 max-narrow:pb-28">
      <div role="status" className="min-w-0">
        {notes.map((note) => (
          <p key={note} className="m-0">
            {note}
          </p>
        ))}
      </div>
      {failed ? (
        <button
          type="button"
          onClick={onRetry}
          className="hit-area h-32 shrink-0 rounded-pill px-12 text-caption font-medium text-ink transition hover:bg-hover-row"
        >
          {t('picker.retry')}
        </button>
      ) : null}
    </div>
  );
}
