import { useState, type JSX } from 'react';
import { api } from '../lib/api';

interface Props {
  rootDir: string;
  siteUrl: string;
  username: string;
  onBack: () => void;
  onSwitchFolder: (rootDir: string) => void;
}

interface Banner {
  kind: 'info' | 'good' | 'bad';
  text: string;
}

export function Settings({ rootDir, siteUrl, username, onBack, onSwitchFolder }: Props): JSX.Element {
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);

  async function testCredentials(): Promise<void> {
    setBusy(true);
    setBanner({ kind: 'info', text: 'Testing credentials…' });
    const r = await api.testAuth({ siteUrl, username, password: '' });
    if (r.ok) {
      setBanner({ kind: 'good', text: `Authenticated as "${r.slug}" (id ${r.id}).` });
    } else if (r.code === 'auth') {
      // 'auth' here usually means missing password input — we passed empty.
      setBanner({
        kind: 'info',
        text: 'Stored credentials cannot be tested without a password. Update the password to verify.',
      });
    } else {
      setBanner({ kind: 'bad', text: r.message });
    }
    setBusy(false);
  }

  async function updatePassword(): Promise<void> {
    if (!newPassword) {
      setBanner({ kind: 'bad', text: 'Enter a new Application Password first.' });
      return;
    }
    setBusy(true);
    setBanner({ kind: 'info', text: 'Verifying new password…' });
    const auth = await api.testAuth({ siteUrl, username, password: newPassword });
    if (!auth.ok) {
      setBanner({ kind: 'bad', text: `Authentication failed: ${auth.message}` });
      setBusy(false);
      return;
    }
    setBanner({ kind: 'info', text: 'Saving credential…' });
    const r = await api.init({ rootDir, siteUrl, username, password: newPassword });
    if (r.ok) {
      setBanner({ kind: 'good', text: 'Application Password updated.' });
      setNewPassword('');
    } else {
      setBanner({ kind: 'bad', text: r.message });
    }
    setBusy(false);
  }

  async function openConfig(): Promise<void> {
    const r = await api.openConfigFile();
    if (!r.ok) setBanner({ kind: 'bad', text: r.message });
  }

  async function pickAndSwitch(): Promise<void> {
    const chosen = await api.pickFolder();
    if (!chosen) return;
    setBusy(true);
    const check = await api.checkConfig(chosen);
    if (check.configured) {
      const adopt = await api.adopt(chosen);
      if (adopt.ok) {
        onSwitchFolder(chosen);
      } else {
        setBanner({ kind: 'bad', text: adopt.message });
      }
    } else {
      setBanner({
        kind: 'info',
        text: `Folder ${chosen} is not configured. Use the Setup wizard from a fresh launch to initialize it.`,
      });
    }
    setBusy(false);
  }

  return (
    <>
      <div className="header">
        <div>
          <h1>Settings</h1>
          <div className="meta">{siteUrl}</div>
        </div>
        <button onClick={onBack}>← Back</button>
      </div>

      <div className="content">
        <div className="settings-grid">
          <div className="panel">
            <h3>Site</h3>
            <div className="kv">
              <div>Site URL</div>
              <div className="mono">{siteUrl}</div>
              <div>Username</div>
              <div className="mono">{username}</div>
              <div>Content folder</div>
              <div className="mono">{rootDir}</div>
            </div>
            <div className="actions" style={{ marginTop: 12 }}>
              <button onClick={pickAndSwitch} disabled={busy}>
                Switch folder…
              </button>
              <button onClick={openConfig} disabled={busy}>
                Open config.toml
              </button>
            </div>
          </div>

          <div className="panel">
            <h3>Credentials</h3>
            <p style={{ marginTop: 0, color: 'var(--muted)', fontSize: 13 }}>
              The Application Password is stored in the OS keychain (or, if unavailable, an
              encrypted <code>.wpsync/secrets.json</code>).
            </p>
            <div className="actions" style={{ marginBottom: 12 }}>
              <button onClick={testCredentials} disabled={busy}>
                Test stored credentials
              </button>
            </div>
            <div className="field">
              <label htmlFor="newPassword">New Application Password</label>
              <input
                id="newPassword"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={busy}
              />
            </div>
            <div className="actions">
              <button className="primary" onClick={updatePassword} disabled={busy || !newPassword}>
                Update password
              </button>
            </div>
          </div>
        </div>

        {banner && <div className={`banner ${banner.kind}`} style={{ marginTop: 16 }}>{banner.text}</div>}
      </div>
    </>
  );
}
