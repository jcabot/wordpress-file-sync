import { useEffect, useRef, useState, type JSX } from 'react';
import {
  api,
  type BridgeEvent,
  type ConflictResolutions,
  type DoneEvent,
  type ItemEvent,
  type LogEvent,
  type StatusCounts,
} from '../lib/api';
import { ConflictModal } from '../components/ConflictModal';

interface Props {
  rootDir: string;
  siteUrl: string;
  onOpenSettings: () => void;
}

interface LogLine {
  ts: string;
  text: string;
  cls?: string;
}

type Phase = 'idle' | 'pulling' | 'pushing';

const EMPTY_COUNTS: StatusCounts = {
  pendingPull: 0,
  pendingPush: 0,
  conflict: 0,
  tombstone: 0,
  newLocal: 0,
  upToDate: 0,
};

function fmtTs(): string {
  return new Date().toTimeString().slice(0, 8);
}

export function Main({ rootDir, siteUrl, onOpenSettings }: Props): JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<string>('');
  const [counts, setCounts] = useState<StatusCounts>(EMPTY_COUNTS);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [conflictSlugs, setConflictSlugs] = useState<string[] | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  function appendLog(text: string, cls?: string): void {
    setLog((prev) => [...prev.slice(-499), { ts: fmtTs(), text, ...(cls ? { cls } : {}) }]);
  }

  useEffect(() => {
    return api.onEvent((evt: BridgeEvent) => {
      if (evt.type === 'item') {
        const it = evt.payload as ItemEvent;
        const total = it.total > 0 ? `/${it.total}` : '';
        setProgress(`${it.op} ${it.index}${total} — ${it.slug}`);
        appendLog(`[${it.op} ${it.index}${total}] ${it.slug}: ${it.action}`, `ev-${it.action}`);
      } else if (evt.type === 'done') {
        const d = evt.payload as DoneEvent;
        appendLog(`${d.op} done: ${d.written} written, ${d.skipped} skipped`);
        setProgress('');
      } else if (evt.type === 'log') {
        const l = evt.payload as LogEvent;
        appendLog(l.msg, l.level === 'error' ? 'ev-error' : undefined);
      } else if (evt.type === 'conflict') {
        const c = evt.payload as { slugs: string[] };
        appendLog(`Conflict on: ${c.slugs.join(', ')}`, 'ev-error');
      }
    });
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [log.length]);

  async function refreshStatus(): Promise<void> {
    const r = await api.status();
    if (r.ok) {
      setCounts(r.counts);
      setLastSync(r.lastSync);
      setError(null);
    } else {
      setError(`Status: ${r.message}`);
    }
  }

  async function runPull(force = false): Promise<void> {
    setError(null);
    setPhase('pulling');
    appendLog('Pull started…');
    const r = await api.pull({ forcePull: force });
    setPhase('idle');
    if (r.ok) {
      appendLog(`Pull complete: ${r.written} item(s).`);
    } else if (r.code === 'conflict') {
      const slugs = r.slugs ?? [];
      appendLog(`Pull halted: conflict on ${slugs.join(', ')}`, 'ev-error');
      setConflictSlugs(slugs);
    } else {
      setError(`Pull failed: ${r.message}`);
      appendLog(`Pull failed: ${r.message}`, 'ev-error');
    }
    void refreshStatus();
  }

  async function runPush(force = false): Promise<void> {
    setError(null);
    setPhase('pushing');
    appendLog('Push started…');
    const r = await api.push({ forcePush: force });
    setPhase('idle');
    if (r.ok) {
      appendLog(`Push complete: ${r.written} item(s) written, ${r.skipped} skipped.`);
    } else if (r.code === 'conflict') {
      const slugs = r.slugs ?? [];
      appendLog(`Push halted: conflict on ${slugs.join(', ')}`, 'ev-error');
      setConflictSlugs(slugs);
    } else {
      setError(`Push failed: ${r.message}`);
      appendLog(`Push failed: ${r.message}`, 'ev-error');
    }
    void refreshStatus();
  }

  async function applyResolutions(resolutions: ConflictResolutions): Promise<void> {
    setConflictSlugs(null);
    setError(null);
    setPhase('pulling');
    appendLog(`Applying resolutions for ${Object.keys(resolutions).length} conflict(s)…`);
    const r1 = await api.pull({ resolutions });
    if (!r1.ok && r1.code !== 'conflict') {
      setError(`Resolve failed (pull): ${r1.message}`);
      appendLog(`Resolve failed (pull): ${r1.message}`, 'ev-error');
      setPhase('idle');
      void refreshStatus();
      return;
    }
    setPhase('pushing');
    const r2 = await api.push({ resolutions });
    setPhase('idle');
    if (r2.ok) {
      appendLog(`Resolutions applied.`);
    } else {
      setError(`Resolve failed (push): ${r2.message}`);
      appendLog(`Resolve failed (push): ${r2.message}`, 'ev-error');
    }
    void refreshStatus();
  }

  const busy = phase !== 'idle';

  return (
    <>
      <div className="header">
        <div>
          <h1>{siteUrl}</h1>
          <div className="meta">{rootDir}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div className="meta">
            last sync: <strong>{lastSync ?? 'never'}</strong>
          </div>
          <button onClick={onOpenSettings} aria-label="Settings" title="Settings">
            ⚙
          </button>
        </div>
      </div>

      <div className="content">
        {error && <div className="banner bad">{error}</div>}

        <div className="actions-strip">
          <button className="primary" disabled={busy} onClick={() => runPull(false)}>
            {phase === 'pulling' ? 'Pulling…' : 'Pull'}
          </button>
          <button disabled={busy} onClick={() => runPush(false)}>
            {phase === 'pushing' ? 'Pushing…' : 'Push'}
          </button>
          <button disabled={busy} onClick={() => void refreshStatus()}>
            Refresh status
          </button>
          <div className="progress">{progress || (busy ? 'Working…' : 'Idle')}</div>
        </div>

        <div className="main-grid">
          <div className="panel">
            <h3>Status</h3>
            <div className="count-row">
              <span>Pending pulls (server changed)</span>
              <span className={`badge ${counts.pendingPull > 0 ? 'warn' : ''}`}>{counts.pendingPull}</span>
            </div>
            <div className="count-row">
              <span>Pending pushes (local changed)</span>
              <span className={`badge ${counts.pendingPush > 0 ? 'warn' : ''}`}>{counts.pendingPush}</span>
            </div>
            <div className="count-row">
              <span>New local files</span>
              <span className={`badge ${counts.newLocal > 0 ? 'warn' : ''}`}>{counts.newLocal}</span>
            </div>
            <div className="count-row">
              <span>Tombstones queued</span>
              <span className={`badge ${counts.tombstone > 0 ? 'warn' : ''}`}>{counts.tombstone}</span>
            </div>
            <div className="count-row">
              <span>Conflicts</span>
              <span className={`badge ${counts.conflict > 0 ? 'bad' : ''}`}>{counts.conflict}</span>
            </div>
            <div className="count-row">
              <span>Up to date</span>
              <span className={`badge good`}>{counts.upToDate}</span>
            </div>
          </div>

          <div className="panel">
            <h3>Conflict resolution</h3>
            <p style={{ marginTop: 0, color: 'var(--muted)', fontSize: 13 }}>
              On conflict, the global force buttons resolve every conflict the same way. The
              per-slug picker arrives in the next milestone.
            </p>
            <div className="actions">
              <button disabled={busy} onClick={() => runPull(true)}>
                Force pull (server wins)
              </button>
              <button disabled={busy} onClick={() => runPush(true)}>
                Force push (local wins)
              </button>
            </div>
          </div>
        </div>

        <h3 style={{ marginTop: 24, marginBottom: 8, color: 'var(--muted)', fontSize: 12, letterSpacing: '0.05em' }}>
          ACTIVITY
        </h3>
        <div className="log">
          {log.length === 0 && <div className="ts">No activity yet.</div>}
          {log.map((line, i) => (
            <div key={i}>
              <span className="ts">{line.ts}</span>
              <span className={line.cls}>{line.text}</span>
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      </div>

      {conflictSlugs && (
        <ConflictModal
          slugs={conflictSlugs}
          onClose={() => setConflictSlugs(null)}
          onApply={(resolutions) => {
            void applyResolutions(resolutions);
          }}
        />
      )}
    </>
  );
}
