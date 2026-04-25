'use client';

import { useState } from 'react';
import Link from 'next/link';
import { WalletButton } from '@/components/wallet-button';
import { CreateMarketWizard } from '@/components/create-market-wizard';

type Tab = 'new' | 'mixed';

export default function CreateMarketPage() {
  const [activeTab, setActiveTab] = useState<Tab>('new');

  return (
    <div className="cm-page">
      <header className="cm-header">
        <Link href="/" className="cm-header__back">← Opinologos</Link>
        <WalletButton />
      </header>

      <section className="cm-hero">
        <div className="cm-hero__tag">New Market</div>
        <h1 className="cm-hero__title">Create a<br /><em>prediction market</em></h1>
        <p className="cm-hero__sub">
          Generate a schema, pin it to IPFS, prepare the condition, and deploy the outcome space — all in one flow.
        </p>
      </section>

      <div className="cm-tabs">
        <button
          className={`cm-tab ${activeTab === 'new' ? 'cm-tab--active' : ''}`}
          onClick={() => setActiveTab('new')}
        >
          New
        </button>
        <button
          className={`cm-tab ${activeTab === 'mixed' ? 'cm-tab--active' : ''}`}
          onClick={() => setActiveTab('mixed')}
        >
          Mixed
        </button>
      </div>

      <main className="cm-content">
        {activeTab === 'new' && <CreateMarketWizard />}
        {activeTab === 'mixed' && (
          <div className="cm-placeholder">
            <span className="cm-placeholder__icon">◈</span>
            <p className="cm-placeholder__text">Mixed markets coming soon.</p>
            <p className="cm-placeholder__sub">
              Combine multiple prediction variables into a composite market.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
