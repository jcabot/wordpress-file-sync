import { useState, type FormEvent, type JSX } from 'react';
import { api } from '../lib/api';
import { FolderPicker } from '../components/FolderPicker';

interface Props {
  onConfigured: (rootDir: string) => void;
  initialRootDir?: string;
}

type Phase = 'idle' | 'verifying-url' | 'verifying-auth' | 'writing' | 'error' | 'done';

interface Banner {
  kind: 'info' | 'bad' | 'good';
  text: string;
}

export function Setup({ onConfigured, initialRootDir }: Props): JSX.Element {
  const [siteUrl, setSiteUrl] = useState('');
  const [rootDir, setRootDir] = useState(initialRootDir ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [banner, setBanner] = useState<Banner | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setBanner(null);

    const trimmedUrl = siteUrl.trim();
    if (!/^https?:\/\//.test(trimmedUrl)) {
      setBanner({ kind: 'bad', text: 'Site URL must start with http:// or https://' });
      return;
    }
    if (!rootDir) {
      setBanner({ kind: 'bad', text: 'Pick a content folder.' });
      return;
    }
    if (!username || !password) {
      setBanner({ kind: 'bad', text: 'Username and Application Password are required.' });
      return;
    }

    setPhase('verifying-url');
    const probe = await api.testWpJson(trimmedUrl);
    if (!probe.ok) {
      setPhase('error');
      setBanner({ kind: 'bad', text: `Site URL check failed: ${probe.message ?? 'unknown'}` });
      return;
    }

    setPhase('verifying-auth');
    const auth = await api.testAuth({ siteUrl: trimmedUrl, username, password });
    if (!auth.ok) {
      setPhase('error');
      setBanner({ kind: 'bad', text: `Authentication failed: ${auth.message}` });
      return;
    }

    setPhase('writing');
    const result = await api.init({ rootDir, siteUrl: trimmedUrl, username, password });
    if (!result.ok) {
      setPhase('error');
      setBanner({ kind: 'bad', text: `Could not write config: ${result.message}` });
      return;
    }

    setPhase('done');
    setBanner({ kind: 'good', text: 'Configured. Loading…' });
    onConfigured(rootDir);
  }

  const busy =
    phase === 'verifying-url' || phase === 'verifying-auth' || phase === 'writing';

  return (
    <>
    <div className="setup">
      <span className="kicker">First edition · setup</span>
      <h2>Connect a <em>WordPress</em> site</h2>
      <p className="lead">
        Mirror posts and pages into a local folder you can edit and version with Git. Round-trip is
        verbatim — Gutenberg block markers, shortcodes, and HTML are preserved byte-for-byte.
      </p>

      <form onSubmit={submit}>
        <div className="field">
          <span className="field-num">№ 01</span>
          <label htmlFor="siteUrl">Site URL</label>
          <input
            id="siteUrl"
            type="url"
            placeholder="https://example.com"
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            disabled={busy}
            autoFocus
          />
          <div className="hint">The base URL of your WordPress site. We probe <code>/wp-json/</code> to verify.</div>
        </div>

        <div className="field">
          <span className="field-num">№ 02</span>
          <label htmlFor="rootDir">Content folder</label>
          <div className="field-row">
            <input
              id="rootDir"
              type="text"
              placeholder="C:\path\to\my-blog"
              value={rootDir}
              onChange={(e) => setRootDir(e.target.value)}
              disabled={busy}
            />
            <button type="button" className="smallcaps" onClick={() => setPickerOpen(true)} disabled={busy}>
              Browse
            </button>
          </div>
          <div className="hint">Posts will live in <code>posts/</code> and pages in <code>pages/</code> under this folder.</div>
        </div>

        <div className="field">
          <span className="field-num">№ 03</span>
          <label htmlFor="username">WordPress username</label>
          <input
            id="username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={busy}
          />
        </div>

        <div className="field">
          <span className="field-num">№ 04</span>
          <label htmlFor="password">Application Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
          <div className="hint">
            Generate at <em>Users → Profile → Application Passwords</em> in wp-admin. Spaces are optional.
          </div>
        </div>

        {banner && <div className={`banner ${banner.kind}`}>{banner.text}</div>}

        <div className="actions">
          <button type="submit" className="primary" disabled={busy}>
            {phase === 'verifying-url' && 'Verifying site…'}
            {phase === 'verifying-auth' && 'Authenticating…'}
            {phase === 'writing' && 'Writing config…'}
            {(phase === 'idle' || phase === 'error' || phase === 'done') && 'Connect & pull →'}
          </button>
        </div>
      </form>
    </div>
    {pickerOpen && (
      <FolderPicker
        initialPath={rootDir || null}
        onCancel={() => setPickerOpen(false)}
        onPick={(p) => {
          setRootDir(p);
          setPickerOpen(false);
        }}
      />
    )}
    </>
  );
}
