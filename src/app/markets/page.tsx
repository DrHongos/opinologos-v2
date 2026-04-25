'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { WalletButton } from '@/components/wallet-button';

interface Outcome {
  outcomeIndex: number;
  label: string | null;
  tokenAddress: string;
  positionId: string | null;
}

interface Market {
  id: string;
  slug: string;
  question: string;
  description: string | null;
  end_time: string | null;
  oracle: string | null;
  resolution_source: string | null;
  attention_entities: string[] | null;
  attention_topics: string[] | null;
  attention_keywords: string[] | null;
  market_cid: string | null;
  shares_token: string;
  created_at: string;
  outcomes: Outcome[];
}

type FilterKey = 'q' | 'topic' | 'entity' | 'keyword';
type Filters = Record<FilterKey, string>;

const LIMIT = 12;
const EMPTY_FILTERS: Filters = { q: '', topic: '', entity: '', keyword: '' };

function timeUntil(iso: string | null): string {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'Closed';
  const days = Math.floor(diff / 86_400_000);
  if (days > 365) return `${Math.floor(days / 365)}y`;
  if (days > 30) return `${Math.floor(days / 30)}mo`;
  if (days > 1) return `${days}d`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours > 0) return `${hours}h`;
  return '<1h';
}

function shortAddr(addr: string | null): string {
  if (!addr) return '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function buildUrl(f: Filters, off: number): string {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.topic) p.set('topic', f.topic);
  if (f.entity) p.set('entity', f.entity);
  if (f.keyword) p.set('keyword', f.keyword);
  p.set('limit', String(LIMIT));
  p.set('offset', String(off));
  return `/api/markets?${p}`;
}

export default function MarketsPage() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [inputQ, setInputQ] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (f: Filters, off: number, append: boolean) => {
    if (append) setLoadingMore(true); else setLoading(true);
    try {
      const res = await fetch(buildUrl(f, off));
      const data = await res.json();
      setTotal(data.total ?? 0);
      setMarkets(prev => append ? [...prev, ...(data.markets ?? [])] : (data.markets ?? []));
      setOffset(off);
    } finally {
      if (append) setLoadingMore(false); else setLoading(false);
    }
  }, []);

  useEffect(() => { load(EMPTY_FILTERS, 0, false); }, [load]);

  function handleQ(v: string) {
    setInputQ(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const next = { ...filters, q: v };
      setFilters(next);
      load(next, 0, false);
    }, 350);
  }

  function applyFilter(key: FilterKey, value: string) {
    const next = { ...filters, [key]: value };
    setFilters(next);
    load(next, 0, false);
  }

  function removeFilter(key: FilterKey) {
    const next = { ...filters, [key]: '' };
    if (key === 'q') setInputQ('');
    setFilters(next);
    load(next, 0, false);
  }

  function clearAll() {
    setInputQ('');
    setFilters(EMPTY_FILTERS);
    load(EMPTY_FILTERS, 0, false);
  }

  const activeFilters = (Object.entries(filters) as [FilterKey, string][]).filter(([, v]) => v);
  const hasMore = markets.length < total && !loading;

  return (
    <div className="ms-page">
      <header className="ms-header">
        <div className="ms-header__left">
          <Link href="/" className="ms-header__back">← Opinologos</Link>
          <span className="ms-header__sep">/</span>
          <span className="ms-header__crumb">Markets</span>
        </div>
        <WalletButton />
      </header>

      <section className="ms-hero">
        <div className="ms-hero__tag">Prediction Markets</div>
        <h1 className="ms-hero__heading">
          Discover<br /><em>on-chain signals</em>
        </h1>
        <p className="ms-hero__sub">
          Search and explore all deployed prediction markets. Click any tag to filter.
        </p>

        <div className="ms-search">
          <span className="ms-search__prefix">&gt;_</span>
          <input
            className="ms-search__input"
            type="text"
            value={inputQ}
            onChange={e => handleQ(e.target.value)}
            placeholder="Search markets…"
            autoFocus
          />
          {inputQ && (
            <button className="ms-search__clear" onClick={() => removeFilter('q')} aria-label="Clear search">
              ✕
            </button>
          )}
        </div>

        {activeFilters.length > 0 && (
          <div className="ms-active-filters">
            {activeFilters.map(([key, val]) => (
              <button key={key} className="ms-filter-chip" onClick={() => removeFilter(key)}>
                <span className="ms-filter-chip__key">{key}</span>
                <span className="ms-filter-chip__val">{val}</span>
                <span className="ms-filter-chip__x">✕</span>
              </button>
            ))}
            <button className="ms-clear-all" onClick={clearAll}>Clear all</button>
          </div>
        )}
      </section>

      <main className="ms-main">
        <div className="ms-count-bar">
          {loading ? (
            <span className="ms-count-bar__scanning">
              Scanning<LoadingDots />
            </span>
          ) : (
            <span className="ms-count-bar__total">
              <strong>{total}</strong> {total === 1 ? 'market' : 'markets'}
              {filters.q && <em> · "{filters.q}"</em>}
            </span>
          )}
          <div className="ms-count-bar__rule" />
        </div>

        {loading && (
          <div className="ms-grid">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="ms-skeleton" style={{ animationDelay: `${i * 0.06}s` }} />
            ))}
          </div>
        )}

        {!loading && markets.length === 0 && (
          <div className="ms-empty">
            <span className="ms-empty__glyph">◈</span>
            <p className="ms-empty__text">No markets found.</p>
            <p className="ms-empty__sub">Try a different query or remove active filters.</p>
            {activeFilters.length > 0 && (
              <button className="ms-empty__clear" onClick={clearAll}>Clear filters</button>
            )}
          </div>
        )}

        {!loading && markets.length > 0 && (
          <div className="ms-grid">
            {markets.map((m, i) => (
              <MarketCard
                key={m.id}
                market={m}
                index={i}
                onTagClick={applyFilter}
              />
            ))}
          </div>
        )}

        {hasMore && (
          <div className="ms-footer">
            <button
              className="ms-load-more"
              onClick={() => load(filters, offset + LIMIT, true)}
              disabled={loadingMore}
            >
              {loadingMore ? <><span className="ms-load-more__spin" />Loading…</> : `Load more · ${total - markets.length} remaining`}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

function LoadingDots() {
  const [dots, setDots] = useState('');
  useEffect(() => {
    const t = setInterval(() => setDots(d => d.length >= 3 ? '' : d + '.'), 300);
    return () => clearInterval(t);
  }, []);
  return <span className="ms-dots">{dots}</span>;
}

function MarketCard({
  market,
  index,
  onTagClick,
}: {
  market: Market;
  index: number;
  onTagClick: (key: FilterKey, val: string) => void;
}) {
  const topics   = market.attention_topics   ?? [];
  const entities = market.attention_entities ?? [];
  const keywords = market.attention_keywords ?? [];
  const timeLeft = timeUntil(market.end_time);
  const isClosed = timeLeft === 'Closed';
  const hasTags  = topics.length + entities.length + keywords.length > 0;

  return (
    <Link
      href={`/markets/${market.slug}`}
      className="ms-card"
      style={{ animationDelay: `${Math.min(index, 11) * 0.045}s` }}
    >
      <div className="ms-card__accent" />

      <div className="ms-card__body">
        <h2 className="ms-card__question">{market.question}</h2>

        {market.description && (
          <p className="ms-card__desc">{market.description}</p>
        )}

        {market.outcomes.length > 0 && (
          <div className="ms-card__outcomes">
            {market.outcomes.map(o => (
              <span key={o.outcomeIndex} className="ms-outcome">
                {o.label ?? `Outcome ${o.outcomeIndex}`}
              </span>
            ))}
          </div>
        )}

        {hasTags && (
          <div className="ms-card__tags">
            {topics.slice(0, 3).map(t => (
              <button key={t} className="ms-tag ms-tag--topic" onClick={() => onTagClick('topic', t)}>{t}</button>
            ))}
            {entities.slice(0, 2).map(e => (
              <button key={e} className="ms-tag ms-tag--entity" onClick={() => onTagClick('entity', e)}>@{e}</button>
            ))}
            {keywords.slice(0, 3).map(k => (
              <button key={k} className="ms-tag ms-tag--keyword" onClick={() => onTagClick('keyword', k)}>#{k}</button>
            ))}
          </div>
        )}
      </div>

      <footer className="ms-card__footer">
        <div className="ms-card__meta">
          <span className={`ms-meta-time${isClosed ? ' ms-meta-time--closed' : ''}`}>{timeLeft}</span>
          {market.resolution_source && (
            <><span className="ms-meta-sep">·</span><span className="ms-meta-item">{market.resolution_source}</span></>
          )}
          {market.oracle && (
            <><span className="ms-meta-sep">·</span><span className="ms-meta-item ms-meta-item--mono">{shortAddr(market.oracle)}</span></>
          )}
        </div>
        <a
          className="ms-card__ens"
          href={`https://app.ens.domains/${market.slug}.opinologos.eth`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {market.slug}.eth&nbsp;↗
        </a>
      </footer>
    </Link>
  );
}
