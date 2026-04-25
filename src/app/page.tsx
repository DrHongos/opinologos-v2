import Link from "next/link";
import { WalletButton } from "@/components/wallet-button";

export default function Home() {
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
            Opinologos
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
          <WalletButton />
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

        {/* Decorative rule */}
        <div
          style={{
            marginTop: '5rem',
            display: 'flex',
            alignItems: 'center',
            gap: '1rem',
            width: '100%',
            maxWidth: '24rem',
          }}
        >
          <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '0.6rem', letterSpacing: '0.15em', color: 'var(--muted)', textTransform: 'uppercase' }}>
            Connect to begin
          </span>
          <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
        </div>
      </main>
    </div>
  );
}
