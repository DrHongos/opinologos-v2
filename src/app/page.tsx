import Link from "next/link";
import { WalletButton } from "@/components/wallet-button";

export default function Home() {
  const mcp_link="claude mcp add di --transport http https://opinologos-v2.vercel.app/api/mcp"
  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--ink)' }}>
      {/* Header */}
      <header
        style={{
          borderBottom: '1px solid var(--border)',
          padding: '1.25rem 2rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
          <span
            style={{
              fontFamily: 'var(--font-geist-mono)',
              fontSize: '0.65rem',
              letterSpacing: '0.2em',
              textTransform: 'uppercase',
              color: 'var(--amber)',
            }}
          >
            ◈
          </span>
          <span
            style={{
              fontFamily: 'var(--font-geist-sans)',
              fontSize: '1rem',
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--paper)',
            }}
          >
            Declareindependence
          </span>
        </div>
        <WalletButton />
      </header>

      {/* Hero */}
      <main
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '6rem 2rem',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--font-geist-mono)',
            fontSize: '0.65rem',
            letterSpacing: '0.25em',
            textTransform: 'uppercase',
            color: 'var(--amber)',
            marginBottom: '1.5rem',
          }}
        >
          On-Chain Opinions
        </div>

        <h1
          style={{
            fontSize: 'clamp(2.5rem, 8vw, 6rem)',
            fontWeight: 800,
            lineHeight: 0.95,
            letterSpacing: '-0.03em',
            color: 'var(--paper)',
            maxWidth: '14ch',
            marginBottom: '2rem',
          }}
        >
          Your opinion,
          <br />
          <span style={{ color: 'var(--amber)' }}>on record.</span>
        </h1>

        <p
          style={{
            color: 'var(--muted)',
            fontSize: '1.1rem',
            lineHeight: 1.7,
            maxWidth: '38ch',
            marginBottom: '3rem',
          }}
        >
          Cast verifiable votes. Build credibility. Shape the discourse — wallet-first.
        </p>

        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
          {/* <WalletButton /> */}
          <Link
            href="/markets"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.6rem 1.25rem',
              border: '1px solid var(--border)',
              color: 'var(--muted)',
              fontFamily: 'var(--font-geist-mono)',
              fontSize: '0.8rem',
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              textDecoration: 'none',
              transition: 'color 0.15s, border-color 0.15s',
            }}
          >
            Browse Markets →
          </Link>
          <Link
            href="/create-market"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.6rem 1.25rem',
              border: '1px solid var(--border)',
              color: 'var(--muted)',
              fontFamily: 'var(--font-geist-mono)',
              fontSize: '0.8rem',
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              textDecoration: 'none',
              transition: 'color 0.15s, border-color 0.15s',
            }}
          >
            Create Market →
          </Link>
        </div>
        
        
        <div className="max-w-l mx-auto p-2 border rounded-xl shadow-sm bg-gray mt-4">
          <p className="text-sm text-gray-500 mb-2">
            Install via MCP link
          </p>

          <div className="flex items-center gap-2 bg-gray-100 rounded-xl px-3 py-2">
            <code id="mcp-link" className="text-sm text-gray-800 truncate">
              {mcp_link}
            </code>
          </div>

        </div>

        {/* Decorative rule */}
        <div
          style={{
            marginTop: '5rem',
            display: 'grid grid-col',
            alignItems: 'center',
            gap: '1rem',
            width: '100%',
            maxWidth: '24rem',
          }}
        >
          <a className="resource" target="_blank" rel="nofollow" href="https://conditional-tokens.readthedocs.io/en/latest/">Gnosis conditional token framework</a>
          <a className="resource" target="_blank" rel="nofollow" href="https://developers.uniswap.org/docs/get-started/quickstart">Uniswap-ai</a>
        </div>
      </main>
    </div>
  );
}
