/** How long the object URL stays alive after the click; iOS Safari starts the download asynchronously. */
const REVOKE_AFTER_MS = 30_000;

/**
 * Saves a file the way spec 7.1 asks: the system share sheet where files can be shared (iPhone: save to Files /
 * iCloud Drive), otherwise a normal browser download. Any share failure falls back to the download, including the
 * user dismissing the sheet (AbortError): a backup should never end up silently not saved.
 */
export async function saveFile(
  name: string,
  data: Blob,
  nav: Pick<Navigator, 'canShare' | 'share'> = navigator,
): Promise<'shared' | 'downloaded'> {
  const file = new File([data], name, { type: data.type });
  let canShare = false;
  try {
    canShare = typeof nav.share === 'function' && nav.canShare?.({ files: [file] }) === true;
  } catch {
    canShare = false;
  }
  if (canShare) {
    try {
      await nav.share({ files: [file] });
      return 'shared';
    } catch {
      // Not allowed, cancelled or failed: download instead.
    }
  }

  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  }
  return 'downloaded';
}
