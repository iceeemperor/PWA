import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildMarkdownZip, type JournalLike, type NoteLike } from '../../src/backup/export-markdown';

let n = 0;
function note(over: Partial<NoteLike> = {}): NoteLike {
  n += 1;
  return {
    id: `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`,
    kind: 'note',
    title: '',
    body: '',
    created_at: '2026-11-05T00:00:00.000Z',
    labels: [],
    pinned: false,
    color: null,
    deleted_at: null,
    ...over,
  };
}
function j(date: string, deleted_at: string | null = null): JournalLike {
  return { date, body: 'dear diary', deleted_at };
}
function unzip(bytes: Uint8Array): Record<string, string> {
  return Object.fromEntries(Object.entries(unzipSync(bytes)).map(([k, v]) => [k, strFromU8(v)]));
}

describe('buildMarkdownZip', () => {
  it('writes notes with front matter, journal by date and memos on one line each', () => {
    const files = unzip(buildMarkdownZip({ notes: [note({ id: 'abcdef12-0000-4000-8000-000000000000', kind: 'note', title: 'Plan', body: 'hello', labels: ['a'], pinned: true })], journal: [{ date: '2026-11-05', body: 'dear diary', deleted_at: null }] }, 'all'));
    expect(Object.keys(files).sort()).toEqual(['journal/2026-11-05.md', 'notes/abcdef12-Plan.md']);
    expect(files['notes/abcdef12-Plan.md']).toMatch(/^---\nid: abcdef12-0000-4000-8000-000000000000\n[\s\S]*pinned: true\n[\s\S]*---\n\nhello/);
    expect(files['notes/abcdef12-Plan.md']).toContain('labels: [a]\n');
    expect(files['notes/abcdef12-Plan.md']).toContain('color: null\n');
    expect(files['journal/2026-11-05.md']).toBe('dear diary');
  });
  it('merges memos into memos.md, one line each', () => {
    const files = unzip(buildMarkdownZip({ notes: [note({ kind: 'memo', body: 'a\nb' }), note({ kind: 'memo', body: 'c\r\nd\re' })], journal: [] }, 'all'));
    expect(files['memos.md'].trim().split('\n')).toEqual(['- a b', '- c d e']);
  });
  it('omits memos.md when there are no live memos', () => {
    const files = unzip(buildMarkdownZip({ notes: [note({ kind: 'memo', deleted_at: 'x' }), note({ kind: 'note', title: 'T' })], journal: [] }, 'all'));
    expect(Object.keys(files).some((k) => k === 'memos.md')).toBe(false);
  });
  it('journal scope contains only journal files', () => expect(Object.keys(unzip(buildMarkdownZip({ notes: [note({ kind: 'note' }), note({ kind: 'memo', body: 'm' })], journal: [j('2026-11-05')] }, 'journal')))).toEqual(['journal/2026-11-05.md']));
  it('leaves out trashed content', () => expect(Object.keys(unzip(buildMarkdownZip({ notes: [note({ kind: 'note', deleted_at: 'x' })], journal: [j('2026-11-05', 'x')] }, 'all')))).toEqual([]));
  it('sanitises titles for file names', () => expect(Object.keys(unzip(buildMarkdownZip({ notes: [note({ id: 'abcdef12-0', kind: 'note', title: 'a/b?c' })], journal: [] }, 'all')))).toEqual(['notes/abcdef12-a-b-c.md']));
  it('truncates long titles to 40 characters', () => {
    const keys = Object.keys(unzip(buildMarkdownZip({ notes: [note({ id: 'abcdef12-0', title: 'x'.repeat(60) })], journal: [] }, 'all')));
    expect(keys).toEqual([`notes/abcdef12-${'x'.repeat(40)}.md`]);
  });
  it('uses only the prefix for an empty title', () => {
    expect(Object.keys(unzip(buildMarkdownZip({ notes: [note({ id: 'abcdef12-0', title: '  ' })], journal: [] }, 'all')))).toEqual(['notes/abcdef12.md']);
  });
  it('suffixes duplicate paths instead of losing entries', () => {
    const a = note({ id: 'abcdef12-1', title: 'Same' });
    const b = note({ id: 'abcdef12-2', title: 'Same' });
    const c = note({ id: 'abcdef12-3', title: 'Same' });
    const keys = Object.keys(unzip(buildMarkdownZip({ notes: [a, b, c], journal: [] }, 'all'))).sort();
    expect(keys).toEqual(['notes/abcdef12-Same-2.md', 'notes/abcdef12-Same-3.md', 'notes/abcdef12-Same.md']);
  });
  it('quotes YAML-unsafe scalars', () => {
    const files = unzip(buildMarkdownZip({ notes: [note({ id: 'abcdef12-0', title: 'T', labels: ['a: b', 'ok', '#x'], color: '#ff0000' })], journal: [] }, 'all'));
    const text = files['notes/abcdef12-T.md'];
    expect(text).toContain('labels: ["a: b", ok, "#x"]\n');
    expect(text).toContain('color: "#ff0000"\n');
  });
});
