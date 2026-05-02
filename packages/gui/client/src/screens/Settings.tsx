import { useState, type JSX } from 'react';
import { api } from '../lib/api';
import { FolderPicker } from '../components/FolderPicker';

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
  const [pickerOpen, setPickerOpen] = useState(false);

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

  async function trySwitchTo(chosen: string): Promise<void> {
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
      <header className="masthead">
        <div className="masthead-top">
          <span className="vol">Editorial · Settings</span>
          <button className="ghost" onClick={onBack}>← Back to sync</button>
        </div>
        <h1 className="wordmark">
          <em style={{ fontStyle: 'italic', fontVariationSettings: "'opsz' 144, 'SOFT' 60, 'WONK' 1" }}>Settings</em>
        </h1>
        <div className="subtitle-row">
          <div className="subtitle">
            <strong>{siteUrl}</strong>
          </div>
        </div>
        <div className="masthead-rule" />
      </header>

      <div className="content">
        <div className="settings-grid">
          <div className="panel">
            <span className="kicker">Configuration</span>
            <h3>Site &amp; Folder</h3>
            <p>The WordPress site and local folder this app syncs.</p>
            <div className="kv">
              <div>Site URL</div>
              <div>{siteUrl}</div>
              <div>Username</div>
              <div>{username}</div>
              <div>Folder</div>
              <div>{rootDir}</div>
            </div>
            <div className="actions">
              <button onClick={() => setPickerOpen(true)} disabled={busy}>
                Switch folder
              </button>
              <button onClick={openConfig} disabled={busy}>
                Open config.toml
              </button>
            </div>
          </div>

          <div className="panel">
            <span className="kicker">Credentials</span>
            <h3>Credentials</h3>
            <p>
              The Application Password is stored in <code>.wpsync/credentials.json</code> with file
              mode 600 (POSIX). It is gitignored by default.
            </p>
            <div className="actions" style={{ marginTop: 4, marginBottom: 4 }}>
              <button onClick={testCredentials} disabled={busy}>
                Test stored credentials
              </button>
            </div>
            <div className="field" style={{ margin: '20px 0 0' }}>
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

        {banner && <div className={`banner ${banner.kind}`} style={{ marginTop: 24 }}>{banner.text}</div>}
      </div>
      {pickerOpen && (
        <FolderPicker
          initialPath={rootDir}
          onCancel={() => setPickerOpen(false)}
          onPick={(p) => {
            setPickerOpen(false);
            void trySwitchTo(p);
          }}
        />
      )}
    </>
  );
}
