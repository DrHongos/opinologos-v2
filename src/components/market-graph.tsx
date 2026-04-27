'use client';

import { useState, useCallback, useMemo, useEffect } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type NodeProps,
  Handle,
  Position,
  BackgroundVariant,
} from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import '@xyflow/react/dist/style.css';
import { createPublicClient, http } from 'viem';
import { getChain } from '@/lib/chain';
import { FPMM_ABI, LMSR_HOOK_ADDRESS, computeImpliedPrice } from '@/lib/contracts';
import { SwapPanel } from './swap-panel';
import { ConditionPanel } from './condition-panel';

interface Outcome {
  outcomeIndex: number;
  label: string | null;
  tokenAddress: string;
  positionId: string | null;
}

interface ConditionInfo {
  id: string;
  slots: number;
  question?: string | null;
}

interface MarketData {
  id?: string;
  question: string;
  description: string | null;
  os_index: string;
  lmsr_b: string | null;
  condition_id: string;
  conditions: ConditionInfo[];
  outcomes: Outcome[];
}

// ─── Node data shapes ──────────────────────────────────────────────────────

interface RootNodeData extends Record<string, unknown> {
  question: string;
  description: string | null;
}

interface ConditionNodeData extends Record<string, unknown> {
  conditionId: string;
  conditionIndex: number;
  slots: number;
  onOpen: () => void;
}

interface QuestionNodeData extends Record<string, unknown> {
  conditionId: string;
  conditionIndex: number;
  slots: number;
  question: string;
  onOpen: () => void;
}

interface OutcomeNodeData extends Record<string, unknown> {
  outcome: Outcome;
  combinedLabel: string;
  price: number | null;
  onOpen: () => void;
}

// ─── Custom node components ────────────────────────────────────────────────

function RootNode({ data }: NodeProps) {
  const d = data as RootNodeData;
  return (
    <div className="mg-node mg-node--root">
      <Handle type="source" position={Position.Right} />
      <span className="mg-node__tag">Market</span>
      <p className="mg-node__question">{d.question}</p>
      {d.description && <p className="mg-node__desc">{d.description}</p>}
    </div>
  );
}

function ConditionNode({ data }: NodeProps) {
  const d = data as ConditionNodeData;
  return (
    <div className="mg-node mg-node--condition" onClick={d.onOpen} role="button" tabIndex={0}>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <span className="mg-node__tag">Condition {d.conditionIndex + 1}</span>
      <span className="mg-node__id">{d.conditionId.slice(0, 10)}…</span>
      <span className="mg-node__slots">{d.slots} slots</span>
      <span className="mg-node__hint">Click to manage</span>
    </div>
  );
}

function QuestionNode({ data }: NodeProps) {
  const d = data as QuestionNodeData;
  return (
    <div className="mg-node mg-node--question" onClick={d.onOpen} role="button" tabIndex={0}>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <span className="mg-node__tag">Source {d.conditionIndex + 1}</span>
      <p className="mg-node__question">{d.question}</p>
      <span className="mg-node__id">{d.conditionId.slice(0, 10)}…</span>
      <span className="mg-node__slots">{d.slots} slots</span>
      <span className="mg-node__hint">Click to manage</span>
    </div>
  );
}

function OutcomeNode({ data }: NodeProps) {
  const d = data as OutcomeNodeData;
  return (
    <div className="mg-node mg-node--outcome" onClick={d.onOpen} role="button" tabIndex={0}>
      <Handle type="target" position={Position.Left} />
      <span className="mg-node__tag">Position {d.outcome.outcomeIndex}</span>
      <span className="mg-node__label">{d.combinedLabel}</span>
      {d.price !== null && (
        <span className="mg-node__price">{d.price.toFixed(4)} col</span>
      )}
      <span className="mg-node__hint">Click to trade</span>
    </div>
  );
}

const nodeTypes = {
  root: RootNode,
  condition: ConditionNode,
  question: QuestionNode,
  outcome: OutcomeNode,
};

// ─── Dagre layout ──────────────────────────────────────────────────────────

const ROOT_W  = 260; const ROOT_H  = 100;
const COND_W  = 200; const COND_H  = 90;
const QUEST_W = 240; const QUEST_H = 110;
const OUT_W   = 180; const OUT_H   = 80;

function nodeSize(type: string | undefined): [number, number] {
  if (type === 'root')      return [ROOT_W, ROOT_H];
  if (type === 'condition') return [COND_W, COND_H];
  if (type === 'question')  return [QUEST_W, QUEST_H];
  return [OUT_W, OUT_H];
}

function layoutGraph(nodes: Node[], edges: Edge[]) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', ranksep: 100, nodesep: 36 });
  g.setDefaultEdgeLabel(() => ({}));

  nodes.forEach(n => {
    const [w, h] = nodeSize(n.type);
    g.setNode(n.id, { width: w, height: h });
  });
  edges.forEach(e => g.setEdge(e.source, e.target));

  dagre.layout(g);

  return nodes.map(n => {
    const { x, y } = g.node(n.id);
    const [w, h] = nodeSize(n.type);
    return { ...n, position: { x: x - w / 2, y: y - h / 2 } };
  });
}

// ─── Graph builder ─────────────────────────────────────────────────────────

function buildGraph(
  market: MarketData,
  prices: number[] | null,
  onConditionClick: (c: ConditionInfo) => void,
  onOutcomeClick: (o: Outcome) => void,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  nodes.push({
    id: 'root',
    type: 'root',
    position: { x: 0, y: 0 },
    data: { question: market.question, description: market.description } satisfies RootNodeData,
    draggable: false,
  });

  const isMixed = market.conditions.length > 1;

  market.conditions.forEach((cond, ci) => {
    const condId = `cond-${ci}`;
    const useQuestion = isMixed && !!cond.question;
    nodes.push({
      id: condId,
      type: useQuestion ? 'question' : 'condition',
      position: { x: 0, y: 0 },
      data: useQuestion
        ? ({
            conditionId: cond.id,
            conditionIndex: ci,
            slots: cond.slots,
            question: cond.question!,
            onOpen: () => onConditionClick(cond),
          } satisfies QuestionNodeData)
        : ({
            conditionId: cond.id,
            conditionIndex: ci,
            slots: cond.slots,
            onOpen: () => onConditionClick(cond),
          } satisfies ConditionNodeData),
      draggable: false,
    });
    edges.push({
      id: `root-${condId}`,
      source: 'root',
      target: condId,
      style: { stroke: 'rgba(245,245,240,0.25)', strokeWidth: 1.5 },
    });
  });

  market.outcomes.forEach(outcome => {
    const outId = `out-${outcome.outcomeIndex}`;
    const combinedLabel = outcome.label ?? buildCombinedLabel(outcome.outcomeIndex, market.conditions);

    nodes.push({
      id: outId,
      type: 'outcome',
      position: { x: 0, y: 0 },
      data: {
        outcome,
        combinedLabel,
        price: prices ? (prices[outcome.outcomeIndex] ?? null) : null,
        onOpen: () => onOutcomeClick(outcome),
      } satisfies OutcomeNodeData,
      draggable: false,
    });

    // Connect each condition to this outcome
    market.conditions.forEach((_, ci) => {
      edges.push({
        id: `cond-${ci}-${outId}`,
        source: `cond-${ci}`,
        target: outId,
        style: { stroke: 'rgba(245,245,240,0.15)', strokeWidth: 1 },
      });
    });
  });

  return { nodes, edges };
}

function buildCombinedLabel(posIdx: number, conditions: ConditionInfo[]): string {
  if (conditions.length === 1) return `Outcome ${posIdx}`;
  const parts: string[] = [];
  let remaining = posIdx;
  for (const cond of conditions) {
    parts.push(`C${cond.id.slice(2, 5)}:${remaining % cond.slots}`);
    remaining = Math.floor(remaining / cond.slots);
  }
  return parts.join(' · ');
}

// ─── Main component ────────────────────────────────────────────────────────

export function MarketGraph({ market }: { market: MarketData }) {
  const [activeCondition, setActiveCondition] = useState<ConditionInfo | null>(null);
  const [activeOutcome, setActiveOutcome] = useState<Outcome | null>(null);
  const [prices, setPrices] = useState<number[] | null>(null);

  const fetchPrices = useCallback(() => {
    if (!market.os_index) return;
    const client = createPublicClient({ chain: getChain(), transport: http() });
    client.readContract({
      address: LMSR_HOOK_ADDRESS,
      abi: FPMM_ABI,
      functionName: 'getPoolBalances',
      args: [market.os_index as `0x${string}`],
    })
      .then(bals => {
        const b = bals as bigint[];
        setPrices(b.map((_, i) => computeImpliedPrice(b, i)));
      })
      .catch(() => {});
  }, [market.os_index]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchPrices(); }, [fetchPrices]);

  const { rawNodes, rawEdges } = useMemo(
    () => {
      const { nodes, edges } = buildGraph(market, prices, setActiveCondition, setActiveOutcome);
      return { rawNodes: nodes, rawEdges: edges };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [market.id ?? market.condition_id, prices],
  );

  const nodes = useMemo(
    () => layoutGraph(rawNodes, rawEdges),
    [rawNodes, rawEdges],
  );

  const onClose = useCallback(() => {
    setActiveCondition(null);
    setActiveOutcome(null);
  }, []);

  return (
    <div className="mg-canvas">
      <ReactFlow
        nodes={nodes}
        edges={rawEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        proOptions={{ hideAttribution: false }}
        minZoom={0.3}
        maxZoom={2}
        colorMode="dark"
      >
        <Background color="rgba(245,245,240,0.04)" variant={BackgroundVariant.Dots} gap={24} />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={n =>
            n.type === 'root' ? '#f59e0b' :
            n.type === 'condition' ? '#92400e' :
            '#2a2a2a'
          }
          maskColor="rgba(13,13,13,0.7)"
        />
      </ReactFlow>

      <SwapPanel
        outcome={activeOutcome}
        osIndex={market.os_index}
        onClose={onClose}
        onTxSuccess={fetchPrices}
      />
      <ConditionPanel
        condition={activeCondition}
        osIndex={market.os_index}
        ptokenAddress={market.outcomes[0]?.tokenAddress ?? ''}
        onClose={onClose}
        onTxSuccess={fetchPrices}
      />
    </div>
  );
}
