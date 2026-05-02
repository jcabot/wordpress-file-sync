import { type JSX, useEffect, useRef, useState } from 'react';
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
        setProgress(`${it.op} ${it.index}${total}: ${it.slug}`);
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

  async function runPull(full = false): Promise<void> {
    setError(null);
    setPhase('pulling');
    appendLog(full ? 'Pull all started...' : 'Pull started...');
    const r = await api.pull({ full });
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

  async function runPush(): Promise<void> {
    setError(null);
    setPhase('pushing');
    appendLog('Push started...');
    const r = await api.push({ forcePush: false });
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
    appendLog(`Applying resolutions for ${Object.keys(resolutions).length} conflict(s)...`);
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
      appendLog('Resolutions applied.');
    } else {
      setError(`Resolve failed (push): ${r2.message}`);
      appendLog(`Resolve failed (push): ${r2.message}`, 'ev-error');
    }
    void refreshStatus();
  }

  const busy = phase !== 'idle';

  return (
    <>
      <header className="masthead">
        <div className="masthead-top">
          <span className="vol">WordPress file sync</span>
          <span className="dateline">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</span>
        </div>
        <h1 className="wordmark">
          wpsync<span className="ampersand">live</span>
        </h1>
        <div className="subtitle-row">
          <div className="subtitle">
            <strong>{siteUrl}</strong>
            <span style={{ margin: '0 10px', color: 'var(--ink-faint)' }}>/</span>
            <span>{rootDir}</span>
          </div>
          <div className="subtitle" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span>Last sync: <strong>{lastSync ?? 'not set'}</strong></span>
            <button className="smallcaps" onClick={onOpenSettings} aria-label="Settings">
              Settings
            </button>
          </div>
        </div>
        <div className="masthead-rule" />
      </header>

      <div className="content">
        {error && <div className="banner bad">{error}</div>}

        <div className="actions-strip">
          <button className="primary" disabled={busy} onClick={() => runPull(false)}>
            {phase === 'pulling' ? 'Pulling...' : `Pull new changes since ${lastSync ?? 'the beginning'}`}
          </button>
          <button disabled={busy} onClick={() => runPull(true)}>
            Pull all
          </button>
          <button disabled={busy} onClick={() => runPush()}>
            {phase === 'pushing' ? 'Pushing...' : 'Push'}
          </button>
          <button disabled={busy} onClick={() => void refreshStatus()}>
            Refresh
          </button>
          <div className="progress">{progress || (busy ? 'Working...' : 'Ready.')}</div>
        </div>

        <div className="stats-inset">
          <StatCell label="Pending pulls" value={counts.pendingPull} kind={counts.pendingPull > 0 ? 'warn' : ''} />
          <StatCell label="Pending pushes" value={counts.pendingPush} kind={counts.pendingPush > 0 ? 'warn' : ''} />
          <StatCell label="New local" value={counts.newLocal} kind={counts.newLocal > 0 ? 'warn' : ''} />
          <StatCell label="Tombstones" value={counts.tombstone} kind={counts.tombstone > 0 ? 'warn' : ''} />
          <StatCell label="Conflicts" value={counts.conflict} kind={counts.conflict > 0 ? 'bad' : ''} />
          <StatCell label="Up to date" value={counts.upToDate} kind="good" />
        </div>

        <section className="log-section">
          <span className="kicker">Activity</span>
          <div className="section-title">
            <h3>Sync log</h3>
            <span className="rule" />
            <span className="serial">{log.length} lines</span>
          </div>
          <div className="log">
            {log.length === 0 && <div className="ts">No activity yet. Start a pull, push, or refresh.</div>}
            {log.map((line, i) => (
              <div key={i}>
                <span className="ts">{line.ts}</span>
                <span className={line.cls}>{line.text}</span>
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </section>
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

function StatCell({ label, value, kind }: { label: string; value: number; kind: string }): JSX.Element {
  return (
    <div className={`stat-cell ${kind}`}>
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      <span className="hairline" />
    </div>
  );
}
