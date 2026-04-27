'use client';

import { useState } from 'react';
import Link from 'next/link';
import { WalletButton } from '@/components/wallet-button';
import { CreateMarketWizard } from '@/components/create-market-wizard';
import { MixMarketsWizard } from '@/components/mix-markets-wizard';

type Tab = 'new' | 'mixed';

export default function CreateMarketPage() {
  const [activeTab, setActiveTab] = useState<Tab>('new');

  return (
    <div className="cm-page">
      <header className="cm-header">
        <Link href="/" className="cm-header__back">← Declareindependence</Link>
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
        {activeTab === 'mixed' && <MixMarketsWizard />}
      </main>
    </div>
  );
}
