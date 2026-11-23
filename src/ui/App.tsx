import { useCallback, useEffect, useRef, useState } from 'react';
import { createServices, type Services } from '../app/services';
import type { SessionChange } from '../auth/auth';
import { LocalDbUnavailableError } from '../data/local-db';
import { startSyncTriggers } from '../sync/triggers';
import { LoginPage } from './LoginPage';
import { Shell } from './Shell';
import { UnavailableScreen } from './UnavailableScreen';
import { UpdatePrompt } from './UpdatePrompt';

/** What the local database tells the page while it starts and runs (see LocalDbOptions). */
export type DbSignals = { onVersionChange: () => void; onBlocked: () => void };

// One boot per page load, so StrictMode's double effects do not open a second database or auth listener.
let boot: Promise<Services> | null = null;
function bootServices(signals: DbSignals): Promise<Services> {
  boot ??= createServices(import.meta.env, signals);
  return boot;
}

type RootState =
  | { kind: 'loading'; blocked: boolean }
  | { kind: 'ready'; services: Services }
  | { kind: 'error'; error: unknown }
  // Another tab upgraded the local database; this page's connection is closed and it must reload.
  | { kind: 'version_changed' };

/**
 * Builds the services, then shows the app; a failed start shows why. `create` replaces the real boot in tests and
 * `reload` the page reload.
 */
export function Root({ create, reload }: { create?: (signals: DbSignals) => Promise<Services>; reload?: () => void } = {}) {
  const [state, setState] = useState<RootState>({ kind: 'loading', blocked: false });
  // Boot once per mount: a new `create` function on a re-render must not start another boot.
  const createRef = useRef(create);

  useEffect(() => {
    let live = true;
    // Not gated on `live`: under StrictMode the remount reuses the first boot, whose signals must still land.
    const signals: DbSignals = {
      onBlocked: () => setState((s) => (s.kind === 'loading' ? { kind: 'loading', blocked: true } : s)),
      onVersionChange: () => setState({ kind: 'version_changed' }),
    };
    // Once the connection is gone, a boot that finishes later must not bring the app back on top of it.
    const unlessClosed = (next: RootState) => (s: RootState) => (s.kind === 'version_changed' ? s : next);
    (createRef.current ?? bootServices)(signals).then(
      (services) => live && setState(unlessClosed({ kind: 'ready', services })),
      (error: unknown) => live && setState(unlessClosed({ kind: 'error', error })),
    );
    return () => {
      live = false;
    };
  }, []);

  // The update prompt sits outside every state, so even a version stuck on boot, an error or login can be replaced.
  return (
    <>
      <UpdatePrompt />
      <RootBody state={state} reload={reload ?? (() => location.reload())} />
    </>
  );
}

function RootBody({ state, reload }: { state: RootState; reload: () => void }) {
  if (state.kind === 'loading') {
    return (
      <div className="boot">
        正在启动…
        {state.blocked && <p role="status">请关闭其他打开着本应用的标签页或窗口</p>}
      </div>
    );
  }
  if (state.kind === 'version_changed') {
    return (
      <main className="screen-message" role="alert">
        <p>应用已在另一个标签页更新，请刷新</p>
        <button type="button" onClick={reload}>
          刷新
        </button>
      </main>
    );
  }
  if (state.kind === 'error') {
    if (state.error instanceof LocalDbUnavailableError) return <UnavailableScreen />;
    const message = state.error instanceof Error ? state.error.message : String(state.error);
    return (
      <main className="screen-message" role="alert">
        <h1>启动失败</h1>
        <p>{message}</p>
        <button type="button" onClick={reload}>
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
  const [session, setSession] = useState<SessionChange>(() => ({ userId: auth.getUserId(), expired: auth.expiredAtStart?.() ?? false }));

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
