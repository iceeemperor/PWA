// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveFile } from '../../src/backup/save-file';

const blob = new Blob(['{}'], { type: 'application/json' });
let clicked: HTMLAnchorElement[];

beforeEach(() => {
  clicked = [];
  // jsdom has no object URLs and does not navigate on click.
  URL.createObjectURL = vi.fn(() => 'blob:fake');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('saveFile (brief)', () => {
  it('uses the share sheet when files can be shared', async () => {
    expect(await saveFile('a.json', blob, { canShare: () => true, share: vi.fn().mockResolvedValue(undefined) })).toBe('shared');
  });

  it('falls back to a download when sharing is unavailable or fails', async () => {
    expect(await saveFile('a.json', blob, { canShare: () => false, share: vi.fn() })).toBe('downloaded');
  });
});

describe('saveFile: edges', () => {
  it('shares a File with the given name and type', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    await saveFile('a.json', blob, { canShare: () => true, share });
    const file = share.mock.calls[0][0].files[0] as File;
    expect(file.name).toBe('a.json');
    expect(file.type).toBe('application/json');
    expect(clicked).toHaveLength(0);
  });

  it('downloads when share rejects', async () => {
    const share = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    expect(await saveFile('a.json', blob, { canShare: () => true, share })).toBe('downloaded');
    expect(clicked).toHaveLength(1);
  });

  it('downloads when the user dismisses the share sheet (AbortError), so a backup is never silently lost', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError'));
    expect(await saveFile('a.json', blob, { canShare: () => true, share })).toBe('downloaded');
    expect(clicked).toHaveLength(1);
  });

  it('downloads when the navigator has no canShare at all', async () => {
    expect(await saveFile('a.json', blob, {} as Pick<Navigator, 'canShare' | 'share'>)).toBe('downloaded');
  });

  it('clicks an <a download> with the file name and revokes the URL later', async () => {
    vi.useFakeTimers();
    await saveFile('b.zip', blob, { canShare: () => false, share: vi.fn() });
    expect(clicked[0].download).toBe('b.zip');
    expect(clicked[0].href).toBe('blob:fake');
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake');
    expect(document.querySelector('a[download]')).toBeNull();
  });
});
