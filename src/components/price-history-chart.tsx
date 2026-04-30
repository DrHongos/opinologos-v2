'use client';

import { useEffect, useState } from 'react';

interface Snapshot {
  outcomeIndex: number;
  price: number;
  recordedAt: string;
}

interface Props {
  slug: string;
  outcomeLabels: string[];
}

const COLORS = ['#14b8a6', '#f59e0b', '#818cf8', '#fb7185', '#34d399', '#60a5fa', '#e879f9', '#facc15'];

const W = 600;
const H = 220;
const PAD = { top: 16, right: 16, bottom: 32, left: 40 };

function toX(t: number, tMin: number, tMax: number) {
  if (tMax === tMin) return PAD.left + (W - PAD.left - PAD.right) / 2;
  return PAD.left + ((t - tMin) / (tMax - tMin)) * (W - PAD.left - PAD.right);
}

function toY(p: number) {
  return PAD.top + (1 - p) * (H - PAD.top - PAD.bottom);
}

function formatLabel(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function PriceHistoryChart({ slug, outcomeLabels }: Props) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/markets/${slug}/price-history`)
      .then(r => r.json())
      .then(d => setSnapshots(d.snapshots ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [slug]);

  if (loading) return null;
  if (snapshots.length === 0) return null;

  // Group by outcome
  const byOutcome: Record<number, Snapshot[]> = {};
  for (const s of snapshots) {
    (byOutcome[s.outcomeIndex] ??= []).push(s);
  }

  const times = snapshots.map(s => new Date(s.recordedAt).getTime());
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);

  // Y-axis gridlines at 0%, 25%, 50%, 75%, 100%
  const yLines = [0, 0.25, 0.5, 0.75, 1];

  // X-axis tick timestamps (up to 5)
  const allTimes = [...new Set(times)].sort((a, b) => a - b);
  const step = Math.max(1, Math.floor(allTimes.length / 4));
  const xTicks = allTimes.filter((_, i) => i % step === 0 || i === allTimes.length - 1);

  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">
        Price History
      </h2>

      <div style={{ overflowX: 'auto' }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', minWidth: 300 }}>
          {/* gridlines */}
          {yLines.map(p => (
            <line
              key={p}
              x1={PAD.left}
              y1={toY(p)}
              x2={W - PAD.right}
              y2={toY(p)}
              stroke="rgba(245,245,240,0.08)"
              strokeWidth={1}
            />
          ))}

          {/* y-axis labels */}
          {yLines.map(p => (
            <text
              key={p}
              x={PAD.left - 6}
              y={toY(p) + 4}
              textAnchor="end"
              fontSize={9}
              fill="rgba(245,245,240,0.35)"
            >
              {Math.round(p * 100)}%
            </text>
          ))}

          {/* x-axis tick labels */}
          {xTicks.map(t => {
            const snap = snapshots.find(s => new Date(s.recordedAt).getTime() === t);
            return (
              <text
                key={t}
                x={toX(t, tMin, tMax)}
                y={H - 6}
                textAnchor="middle"
                fontSize={9}
                fill="rgba(245,245,240,0.35)"
              >
                {snap ? formatLabel(snap.recordedAt) : ''}
              </text>
            );
          })}

          {/* outcome lines */}
          {Object.entries(byOutcome).map(([idxStr, pts]) => {
            const idx = Number(idxStr);
            const color = COLORS[idx % COLORS.length];
            const points = pts
              .map(s => `${toX(new Date(s.recordedAt).getTime(), tMin, tMax)},${toY(s.price)}`)
              .join(' ');
            return (
              <polyline
                key={idx}
                points={points}
                fill="none"
                stroke={color}
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            );
          })}
        </svg>
      </div>

      {/* legend */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginTop: '0.5rem' }}>
        {Object.keys(byOutcome).map(idxStr => {
          const idx = Number(idxStr);
          const color = COLORS[idx % COLORS.length];
          const label = outcomeLabels[idx] ?? `Outcome ${idx}`;
          return (
            <span key={idx} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem', color: 'rgba(245,245,240,0.6)' }}>
              <span style={{ width: 20, height: 2, background: color, display: 'inline-block', borderRadius: 1 }} />
              {label}
            </span>
          );
        })}
      </div>
    </section>
  );
}
