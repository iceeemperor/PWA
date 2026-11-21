import { useState, type FormEvent } from 'react';
import type { AuthApi, SignInResult } from '../auth/auth';

const FAILURE_TEXT: Record<Exclude<SignInResult, { ok: true }>['reason'], string> = {
  invalid_credentials: '邮箱或密码不对',
  network: '网络连接失败，请检查网络后重试',
  unknown: '登录失败，请稍后再试',
};

export interface LoginPageProps {
  auth: AuthApi;
  /** The previous session ended on its own: say so, and that nothing unsynced was lost. */
  expired: boolean;
  onSignedIn?: () => void;
}

/** Email and password only; accounts are created in the Supabase dashboard (spec 3.3). */
export function LoginPage({ auth, expired, onSignedIn }: LoginPageProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await auth.signIn(email.trim(), password);
    setBusy(false);
    if (r.ok) onSignedIn?.();
    else setError(FAILURE_TEXT[r.reason]);
  }

  return (
    <main className="login">
      <form className="login-card" onSubmit={submit}>
        <h1>个人效率</h1>
        {expired && (
          <p className="notice" role="status">
            登录已过期，请重新登录，未同步的改动已保留
          </p>
        )}
        <label className="field">
          <span>邮箱</span>
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>密码</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          登录
        </button>
      </form>
    </main>
  );
}
