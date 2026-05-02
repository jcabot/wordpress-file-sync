import { useEffect, useState, type JSX } from 'react';
import { Setup } from './screens/Setup';
import { Main } from './screens/Main';
import { Settings } from './screens/Settings';
import { api } from './lib/api';
import './App.css';

interface Configured {
  rootDir: string;
  siteUrl: string;
  username: string;
}

type Mode =
  | { kind: 'loading' }
  | { kind: 'setup' }
  | { kind: 'main'; cfg: Configured }
  | { kind: 'settings'; cfg: Configured };

async function tryLoadConfigured(rootDir: string): Promise<Configured | null> {
  const check = await api.checkConfig(rootDir);
  if (check.configured && check.rootDir && check.siteUrl && check.username) {
    return { rootDir: check.rootDir, siteUrl: check.siteUrl, username: check.username };
  }
  return null;
}

export function App(): JSX.Element {
  const [mode, setMode] = useState<Mode>({ kind: 'loading' });

  useEffect(() => {
    void (async () => {
      const last = await api.lastRootDir();
      if (last) {
        const cfg = await tryLoadConfigured(last);
        if (cfg) {
          const adopt = await api.adopt(cfg.rootDir);
          if (adopt.ok) {
            setMode({ kind: 'main', cfg });
            return;
          }
        }
      }
      setMode({ kind: 'setup' });
    })();
  }, []);

  async function onConfigured(rootDir: string): Promise<void> {
    const cfg = await tryLoadConfigured(rootDir);
    if (cfg) setMode({ kind: 'main', cfg });
    else setMode({ kind: 'setup' });
  }

  async function onSwitchFolder(rootDir: string): Promise<void> {
    const cfg = await tryLoadConfigured(rootDir);
    if (cfg) setMode({ kind: 'main', cfg });
  }

  if (mode.kind === 'loading') {
    return (
      <div className="app">
        <div className="splash">setting type</div>
      </div>
    );
  }

  if (mode.kind === 'setup') {
    return (
      <div className="app">
        <div className="content">
          <Setup onConfigured={onConfigured} />
        </div>
      </div>
    );
  }

  if (mode.kind === 'settings') {
    return (
      <div className="app">
        <Settings
          rootDir={mode.cfg.rootDir}
          siteUrl={mode.cfg.siteUrl}
          username={mode.cfg.username}
          onBack={() => setMode({ kind: 'main', cfg: mode.cfg })}
          onSwitchFolder={onSwitchFolder}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <Main
        rootDir={mode.cfg.rootDir}
        siteUrl={mode.cfg.siteUrl}
        onOpenSettings={() => setMode({ kind: 'settings', cfg: mode.cfg })}
      />
    </div>
  );
}
