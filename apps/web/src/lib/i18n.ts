import en from '@/messages/en.json';

/**
 * Message lookup. English only for now; every user-visible string is a message id so a second
 * locale is a new JSON file and a locale argument, not a code change. Plain functions work in
 * server and client components alike.
 */
export type MessageId = keyof typeof en;
export type MessageParams = Record<string, string | number>;

const messages: Readonly<Record<MessageId, string>> = en;

export function t(id: MessageId, params?: MessageParams): string {
  const template = messages[id];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = params[key];
    return value === undefined ? whole : String(value);
  });
}

/** Picks `<base>.one` or `<base>.other` by the locale's plural rule, with `{count}` filled in. */
export function tPlural(base: 'header.activity', count: number): string {
  const form = new Intl.PluralRules('en').select(count) === 'one' ? 'one' : 'other';
  return t(`${base}.${form}`, { count });
}
