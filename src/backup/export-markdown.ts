import { strToU8, zipSync } from 'fflate';

export interface NoteLike {
  id: string;
  kind: 'memo' | 'note';
  title: string;
  body: string;
  created_at: string;
  labels: string[];
  pinned: boolean;
  color: string | null;
  deleted_at: string | null;
}

export interface JournalLike {
  date: string;
  body: string;
  deleted_at: string | null;
}

const PLAIN_YAML = /^[A-Za-z_][A-Za-z0-9_ ./@+-]*$/;
const YAML_RESERVED = /^(null|true|false|yes|no|on|off|y|n)$/i;

function yamlScalar(value: string): string {
  const plain = PLAIN_YAML.test(value) && !YAML_RESERVED.test(value) && !value.endsWith(' ');
  // Ids and dates start with a digit; allow them unquoted only when they cannot read as a number.
  const idLike = /^[0-9][A-Za-z0-9_./@+-]*-[A-Za-z0-9_./@+-]*$/.test(value) && !/^[0-9.+-]+$/.test(value) && !/^[0-9.]+e[-+]?[0-9]+$/i.test(value);
  return plain || idLike ? value : JSON.stringify(value);
}

function sanitiseTitle(title: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = title.replace(/[/\:*?"<>|\u0000-\u001f\u007f]/g, '-').trim();
  return Array.from(cleaned).slice(0, 40).join('');
}

function frontMatter(n: NoteLike): string {
  return [
    '---',
    `id: ${yamlScalar(n.id)}`,
    `created_at: ${yamlScalar(n.created_at)}`,
    `labels: [${n.labels.map(yamlScalar).join(', ')}]`,
    `pinned: ${n.pinned ? 'true' : 'false'}`,
    `color: ${n.color === null ? 'null' : yamlScalar(n.color)}`,
    '---',
  ].join('\n');
}

export function buildMarkdownZip(data: { notes: NoteLike[]; journal: JournalLike[] }, scope: 'all' | 'journal'): Uint8Array {
  const files: Record<string, Uint8Array> = {};

  if (scope === 'all') {
    const memoLines: string[] = [];
    for (const n of data.notes) {
      if (n.deleted_at !== null) continue;
      if (n.kind === 'memo') {
        memoLines.push(`- ${n.body.replace(/\r\n|\n|\r/g, ' ')}`);
        continue;
      }
      const prefix = Array.from(n.id).slice(0, 8).join('');
      const title = sanitiseTitle(n.title);
      const stem = title === '' ? prefix : `${prefix}-${title}`;
      let path = `notes/${stem}.md`;
      for (let i = 2; path in files; i += 1) path = `notes/${stem}-${i}.md`;
      files[path] = strToU8(`${frontMatter(n)}\n\n${n.body}`);
    }
    if (memoLines.length > 0) files['memos.md'] = strToU8(`${memoLines.join('\n')}\n`);
  }

  for (const e of data.journal) {
    if (e.deleted_at !== null) continue;
    files[`journal/${e.date}.md`] = strToU8(e.body);
  }

  return zipSync(files);
}
