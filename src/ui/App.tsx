import { useCallback, useEffect, useState } from 'react';
import { createServices, type Services } from '../app/services';
import type { SessionChange } from '../auth/auth';
import { LocalDbUnavailableError } from '../data/local-db';
import { startSyncTriggers } from '../sync/triggers';
import { LoginPage } from './LoginPage';
import { Shell } from './Shell';
import { UnavailableScreen } from './UnavailableScreen';

// One boot per page load, so StrictMode's double effects do not open a second database or auth listener.
let boot: Promise<Services> | null = null;
function bootServices(): Promise<Services> {
  boot ??= createServices(import.meta.env);
  return boot;
}

type RootState = { kind: 'loading' } | { kind: 'ready'; services: Services } | { kind: 'error'; error: unknown };

/** Builds the services, then shows the app; a failed start shows why. `create` replaces the real boot in tests. */
export function Root({ create }: { create?: () => Promise<Services> } = {}) {
  const [state, setState] = useState<RootState>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    (create ?? bootServices)().then(
      (services) => live && setState({ kind: 'ready', services }),
      (error: unknown) => live && setState({ kind: 'error', error }),
    );
    return () => {
      live = false;
    };
  }, [create]);

  if (state.kind === 'loading') return <div className="boot">正在启动…</div>;
  if (state.kind === 'error') {
    if (state.error instanceof LocalDbUnavailableError) return <UnavailableScreen />;
    const message = state.error instanceof Error ? state.error.message : String(state.error);
    return (
      <main className="screen-message" role="alert">
        <h1>启动失败</h1>
        <p>{message}</p>
        <button type="button" onClick={() => location.reload()}>
          重新加载
        </button>
      </main>
    );
  }
  return <App services={state.services} />;
}

/** Login page while signed out; the shell, with sync running, while signed in. */
export function App({ services }: { services: Services }) {
  const { auth, engine, repo } = services;
  const [session, setSession] = useState<SessionChange>(() => ({ userId: auth.getUserId(), expired: false }));

  useEffect(() => auth.onSessionChange(setSession), [auth]);

  // The cloud refusing our token is an expiry too, even if the cached session still looks alive.
  useEffect(
    () =>
      engine.subscribe((s) => {
        if (s.state === 'auth_expired') setSession({ userId: null, expired: true });
      }),
    [engine],
  );

  // Sync runs only while signed in. Stopping it never touches the queue.
  const { startSync } = services;
  useEffect(() => {
    if (!session.userId) return;
    return startSync ? startSync() : startSyncTriggers({ engine, repo });
  }, [session.userId, startSync, engine, repo]);

  const onSignedIn = useCallback(() => {
    const userId = auth.getUserId();
    if (userId) setSession({ userId, expired: false });
  }, [auth]);

  if (!session.userId) return <LoginPage auth={auth} expired={session.expired} onSignedIn={onSignedIn} />;
  return <Shell key={session.userId} services={services} />;
}
