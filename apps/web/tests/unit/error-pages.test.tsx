import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import GlobalError from '../../src/app/global-error';
import en from '../../src/messages/en.json';

describe('global-error page', () => {
  const html = renderToStaticMarkup(<GlobalError error={new Error('boom')} reset={() => {}} />);

  it('renders its own html and body with a heading, copy and two real actions', () => {
    expect(html.startsWith('<html lang="en">')).toBe(true);
    expect(html).toContain('<body');
    expect(html).toContain(`<h1`);
    expect(html).toContain(en['error.title']);
    expect(html).toContain(en['error.body']);
    expect(html).toMatch(/<button type="button"[^>]*>Try again<\/button>/);
    expect(html).toMatch(/<a href="\/"[^>]*>Back to Swap<\/a>/);
  });

  it('has no inline style and no style element (strict CSP)', () => {
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/<style[\s>]/);
  });
});
