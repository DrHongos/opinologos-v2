'use client';

import { useState } from 'react';

export function CidRow({ cid }: { cid: string }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(cid).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="md-cid-row">
      <a
        href={`https://ipfsviewer.eth.link/?hash=${cid}`}
        target="_blank"
        rel="noopener noreferrer"
        className="md-cid-row__link"
      >
        Market information
      </a>
      <button className="md-cid-row__copy ml-2" onClick={copy} title="Copy CID">
        {copied ? '✓' : '⎘'}
      </button>
    </div>
  );
}
