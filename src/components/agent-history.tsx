'use client';

import { useEffect, useState } from 'react';

interface AgentEvent {
  id: string;
  created_at: string;
  event_type: 'resolved' | 'nudged' | 'skipped' | 'error';
  confidence: number | null;
  reasoning: string | null;
  sources: string[] | null;
  payouts: number[] | null;
  tx_hash: string | null;
  trade_amount_usdc: string | null;
  probability_delta: string | null;
}

const EXPLORER = 'https://sepolia.uniscan.xyz/tx/';

const TYPE_STYLES: Record<string, { label: string; className: string }> = {
  resolved: { label: 'Resolved', className: 'bg-green-900/40 text-green-300 border border-green-700/50' },
  nudged:   { label: 'Nudged',   className: 'bg-yellow-900/40 text-yellow-300 border border-yellow-700/50' },
  skipped:  { label: 'Skipped',  className: 'bg-zinc-800 text-zinc-400 border border-zinc-700/50' },
  error:    { label: 'Error',    className: 'bg-red-900/40 text-red-300 border border-red-700/50' },
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function shortHash(h: string) {
  return `${h.slice(0, 8)}…${h.slice(-6)}`;
}

export function AgentHistory({ slug }: { slug: string }) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/markets/${slug}/agent-events`)
      .then(r => r.json())
      .then(d => setEvents(d.events ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [slug]);

  if (loading) return null;
  if (events.length === 0) return null;

  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">
        Agent History
      </h2>

      <div className="relative">
        {/* vertical line */}
        <div className="absolute left-3 top-0 bottom-0 w-px bg-zinc-800" />

        <ul className="space-y-4 pl-10">
          {events.map(ev => {
            const style = TYPE_STYLES[ev.event_type] ?? TYPE_STYLES.skipped;
            return (
              <li key={ev.id} className="relative">
                {/* dot */}
                <span className={`absolute -left-7 top-1.5 w-2.5 h-2.5 rounded-full border-2 border-zinc-900 ${
                  ev.event_type === 'resolved' ? 'bg-green-400' :
                  ev.event_type === 'nudged'   ? 'bg-yellow-400' :
                  ev.event_type === 'error'    ? 'bg-red-400' : 'bg-zinc-600'
                }`} />

                <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${style.className}`}>
                      {style.label}
                    </span>
                    {ev.confidence != null && (
                      <span className="text-xs text-zinc-500">
                        {ev.confidence}% confidence
                      </span>
                    )}
                    <span className="text-xs text-zinc-600 ml-auto">
                      {formatDate(ev.created_at)}
                    </span>
                  </div>

                  {ev.reasoning && (
                    <p className="text-sm text-zinc-300 leading-relaxed">{ev.reasoning}</p>
                  )}

                  {ev.event_type === 'nudged' && ev.trade_amount_usdc && ev.probability_delta && (
                    <p className="text-xs text-zinc-500 mt-1">
                      Traded {parseFloat(ev.trade_amount_usdc).toFixed(2)} USDC
                      {' · '}
                      delta {(parseFloat(ev.probability_delta) * 100).toFixed(1)}%
                    </p>
                  )}

                  {ev.tx_hash && (
                    <a
                      href={`${EXPLORER}${ev.tx_hash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block mt-2 text-xs text-blue-400 hover:text-blue-300 font-mono"
                    >
                      {shortHash(ev.tx_hash)}
                    </a>
                  )}

                  {ev.sources && ev.sources.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {ev.sources.slice(0, 3).map((src, i) => {
                        const isUrl = src.startsWith('http');
                        return isUrl ? (
                          <a
                            key={i}
                            href={src}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-zinc-500 hover:text-zinc-300 truncate max-w-[200px]"
                          >
                            {new URL(src).hostname}
                          </a>
                        ) : (
                          <span key={i} className="text-xs text-zinc-600">{src}</span>
                        );
                      })}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
