import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Every ```json block in the KMS runbook must be valid JSON: the owner pastes them. */
const RUNBOOK = resolve(import.meta.dirname, '../../../docs/runbooks/kms-setup.md');

function jsonBlocks(markdown: string): { line: number; text: string }[] {
  const blocks: { line: number; text: string }[] = [];
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() !== '```json') continue;
    const start = i + 1;
    const body: string[] = [];
    for (i = start; i < lines.length && (lines[i] ?? '').trim() !== '```'; i++) {
      body.push(lines[i] ?? '');
    }
    blocks.push({ line: start, text: body.join('\n') });
  }
  return blocks;
}

describe('docs/runbooks/kms-setup.md', () => {
  const blocks = jsonBlocks(readFileSync(RUNBOOK, 'utf8'));

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

  it('every block fits the smallest policy limit that applies (SCP: 10,240 characters minified)', () => {
    for (const { line, text } of blocks) {
      expect(JSON.stringify(JSON.parse(text)).length, `line ${line}`).toBeLessThanOrEqual(10_240);
    }
  });
});
