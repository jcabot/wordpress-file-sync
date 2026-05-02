import { useEffect, useState, type JSX } from 'react';
import { api, type FsListResult } from '../lib/api';

interface Props {
  initialPath?: string | null;
  onCancel: () => void;
  onPick: (path: string) => void;
}

export function FolderPicker({ initialPath, onCancel, onPick }: Props): JSX.Element {
  const [listing, setListing] = useState<FsListResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void navigate(initialPath ?? null);
  }, []);

  async function navigate(path: string | null): Promise<void> {
    setError(null);
    try {
      const result = await api.fsList(path);
      setListing(result);
    } catch (err) {
      if (path !== null) {
        try {
          setListing(await api.fsList(null));
          return;
        } catch {
          // fall through to surfaced error
        }
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="kicker">Filing cabinet</span>
          <h2>Choose a folder</h2>
          <div className="path-trail">{listing?.path ?? 'reading shelf…'}</div>
        </div>

        {error && <div className="banner bad" style={{ margin: '12px 20px 0' }}>{error}</div>}

        <div className="modal-body">
          {listing && (
            <div className="dir-list">
              {listing.parent && (
                <button
                  type="button"
                  className="dir-row"
                  onClick={() => void navigate(listing.parent)}
                >
                  <span className="dir-icon">↩</span>
                  <span>up one level</span>
                </button>
              )}
              {listing.entries.length === 0 && !listing.parent && (
                <div className="ts" style={{ padding: 8, color: 'var(--ink-faint)', fontFamily: 'var(--serif)', fontStyle: 'italic' }}>(no subfolders here)</div>
              )}
              {listing.entries.map((e) => (
                <button
                  key={e.name}
                  type="button"
                  className="dir-row"
                  onClick={() =>
                    void navigate(
                      listing.path.endsWith('/') || listing.path.endsWith('\\')
                        ? `${listing.path}${e.name}`
                        : `${listing.path}${pathSep(listing.path)}${e.name}`,
                    )
                  }
                >
                  <span className="dir-icon">▸</span>
                  <span>{e.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button onClick={onCancel}>Cancel</button>
          <button
            className="primary"
            disabled={!listing}
            onClick={() => listing && onPick(listing.path)}
          >
            Select this folder →
          </button>
        </div>
      </div>
    </div>
  );
}

function pathSep(p: string): string {
  return p.includes('\\') ? '\\' : '/';
}
