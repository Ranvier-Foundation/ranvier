import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Every ```json block in the KMS runbook must be valid JSON: the owner pastes them. */
const RUNBOOK = resolve(import.meta.dirname, '../../../docs/runbooks/kms-setup.md');

function fencedBlocks(markdown: string, lang: string): { line: number; text: string }[] {
  const blocks: { line: number; text: string }[] = [];
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() !== '```' + lang) continue;
    const start = i + 1;
    const body: string[] = [];
    for (i = start; i < lines.length && (lines[i] ?? '').trim() !== '```'; i++) {
      body.push(lines[i] ?? '');
    }
    blocks.push({ line: start, text: body.join('\n') });
  }
  return blocks;
}

const jsonBlocks = (md: string) => fencedBlocks(md, 'json');
/** The ```text blocks in the runbook are CloudWatch Logs filter patterns. */
const textBlocks = (md: string) =>
  fencedBlocks(md, 'text').map((b) => ({ ...b, text: b.text.trim() }));

describe('docs/runbooks/kms-setup.md', () => {
  const markdown = readFileSync(RUNBOOK, 'utf8');
  const blocks = jsonBlocks(markdown);

  it('has policy blocks', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(10);
  });

  it.each(blocks.map((b) => [b.line, b.text] as const))(
    'block at line %i parses as a JSON object',
    (_line, text) => {
      const parsed: unknown = JSON.parse(text);
      expect(typeof parsed).toBe('object');
      expect(parsed).not.toBeNull();
    },
  );

  it('every full policy document has a Statement array', () => {
    for (const { line, text } of blocks) {
      const doc = JSON.parse(text) as Record<string, unknown>;
      if (!('Statement' in doc)) continue; // a single statement to add to a policy
      expect(Array.isArray(doc.Statement), `line ${line}`).toBe(true);
    }
  });

  it('every policy fits 5,120 characters minified (the conservative SCP limit)', () => {
    for (const { line, text } of blocks) {
      expect(JSON.stringify(JSON.parse(text)).length, `line ${line}`).toBeLessThanOrEqual(5_120);
    }
  });

  it('every CloudWatch filter pattern fits 1,024 characters (PutMetricFilter limit)', () => {
    const patterns = textBlocks(markdown);
    expect(patterns.length).toBeGreaterThanOrEqual(10);
    for (const { line, text } of patterns) {
      expect(text.length, `line ${line}`).toBeLessThanOrEqual(1_024);
    }
  });
});
