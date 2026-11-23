import { useCallback, useState } from 'react';
import { InvalidRecordError, LocalWriteError } from '../data/repo';

/** What a failed write tells the user. A refused record says why, so the user can fix the input. */
export function writeErrorMessage(e: unknown): string {
  if (e instanceof LocalWriteError) return '保存失败';
  if (e instanceof InvalidRecordError) return `无法保存：${e.message}`;
  return '操作失败，请重试';
}

/**
 * Runs writes and keeps the message of the last failure (null after a success). `attempt` never throws: it resolves
 * to whether the write went through, so the caller keeps the user's input when it did not.
 */
export function useWriteAttempt() {
  const [error, setError] = useState<string | null>(null);
  const attempt = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn();
      setError(null);
      return true;
    } catch (e) {
      console.error('Write failed', e);
      setError(writeErrorMessage(e));
      return false;
    }
  }, []);
  return { error, setError, attempt };
}

export function WriteError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="error" role="alert">
      {error}
    </p>
  );
}
