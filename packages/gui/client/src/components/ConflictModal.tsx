import { useState, type JSX } from 'react';
import type { ConflictResolution, ConflictResolutions } from '../lib/api';

interface Props {
  slugs: string[];
  onApply: (resolutions: ConflictResolutions) => void;
  onClose: () => void;
}

const OPTIONS: { value: ConflictResolution; label: string; hint: string }[] = [
  { value: 'keep-local', label: 'Keep local', hint: 'Push my edit to the server' },
  { value: 'keep-server', label: 'Keep server', hint: 'Overwrite my file with the server' },
  { value: 'skip', label: 'Skip', hint: 'Decide later (will conflict again)' },
];

export function ConflictModal({ slugs, onApply, onClose }: Props): JSX.Element {
  const [picks, setPicks] = useState<ConflictResolutions>(() =>
    Object.fromEntries(slugs.map((s) => [s, 'skip' as ConflictResolution])),
  );

  function setPick(slug: string, value: ConflictResolution): void {
    setPicks((prev) => ({ ...prev, [slug]: value }));
  }

  function applyAll(value: ConflictResolution): void {
    setPicks(Object.fromEntries(slugs.map((s) => [s, value])));
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="kicker">Errata · {slugs.length} item{slugs.length === 1 ? '' : 's'}</span>
          <h2>Resolve conflicts</h2>
          <p>
            Changed on both sides since the last impression. Pick a winner per item — the run will
            execute in a single pull-then-push pass.
          </p>
        </div>

        <div className="modal-bulk">
          <span>Apply to all</span>
          {OPTIONS.map((opt) => (
            <button key={opt.value} onClick={() => applyAll(opt.value)}>
              {opt.label}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {slugs.map((slug, i) => (
            <div className="conflict-row" key={slug}>
              <div className="conflict-num">№ {String(i + 1).padStart(2, '0')}</div>
              <div>
                <div className="conflict-slug">{slug}</div>
                <div className="conflict-picker">
                  {OPTIONS.map((opt) => (
                    <label key={opt.value} className={picks[slug] === opt.value ? 'active' : ''}>
                      <input
                        type="radio"
                        name={`pick-${slug}`}
                        value={opt.value}
                        checked={picks[slug] === opt.value}
                        onChange={() => setPick(slug, opt.value)}
                      />
                      <span>{opt.label}</span>
                      <span className="hint">{opt.hint}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="modal-footer">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => onApply(picks)}>
            Apply resolutions →
          </button>
        </div>
      </div>
    </div>
  );
}
