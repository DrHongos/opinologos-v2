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
import { SlotPanel, type SlotInfo } from './slot-panel';

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
  onOpen: () => void;
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

interface CondOutcomeNodeData extends Record<string, unknown> {
  label: string;
  price: number | null;
  conditionIndex: number;
  slotIndex: number;
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
    <div className="mg-node mg-node--root" onClick={d.onOpen} role="button" tabIndex={0}>
      <Handle type="source" position={Position.Right} />
      <span className="mg-node__tag">Market</span>
      <p className="mg-node__question">{d.question}</p>
      {d.description && <p className="mg-node__desc">{d.description}</p>}
      <span className="mg-node__hint">Click to fund / manage pool</span>
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

function CondOutcomeNode({ data }: NodeProps) {
  const d = data as CondOutcomeNodeData;
  return (
    <div className="mg-node mg-node--cond-outcome" onClick={d.onOpen} role="button" tabIndex={0}>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <span className="mg-node__tag">Slot {d.slotIndex}</span>
      <span className="mg-node__label">{d.label}</span>
      {d.price !== null && (
        <span className="mg-node__price">{d.price.toFixed(3)}</span>
      )}
      <span className="mg-node__hint">Click to trade / split</span>
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
  condOutcome: CondOutcomeNode,
  outcome: OutcomeNode,
};

// ─── Dagre layout ──────────────────────────────────────────────────────────

const ROOT_W  = 260; const ROOT_H  = 110;
const COND_W  = 200; const COND_H  = 90;
const QUEST_W = 240; const QUEST_H = 110;
const COUT_W  = 160; const COUT_H  = 72;
const OUT_W   = 180; const OUT_H   = 80;

function nodeSize(type: string | undefined): [number, number] {
  if (type === 'root')        return [ROOT_W, ROOT_H];
  if (type === 'condition')   return [COND_W, COND_H];
  if (type === 'question')    return [QUEST_W, QUEST_H];
  if (type === 'condOutcome') return [COUT_W, COUT_H];
  return [OUT_W, OUT_H];
}

function layoutGraph(nodes: Node[], edges: Edge[]) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', ranksep: 90, nodesep: 28 });
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

// Sentinel used when clicking the root node to open pool management panel.
// Empty id tells ConditionPanel to render in pool-management mode.
export const POOL_SENTINEL: ConditionInfo = { id: '', slots: 0 };

function buildGraph(
  market: MarketData,
  prices: number[] | null,
  onConditionClick: (c: ConditionInfo) => void,
  onOutcomeClick: (o: Outcome) => void,
  onPoolOpen: () => void,
  onSlotClick: (s: SlotInfo) => void,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  nodes.push({
    id: 'root',
    type: 'root',
    position: { x: 0, y: 0 },
    data: {
      question: market.question,
      description: market.description,
      onOpen: onPoolOpen,
    } satisfies RootNodeData,
    draggable: false,
  });

  const isMixed = market.conditions.length === 2;

  if (isMixed) {
    // ── 4-level DAG: root → question → condOutcome → combined outcome ──────
    const nA = market.conditions[0].slots;
    const nB = market.conditions[1].slots;

    market.conditions.forEach((cond, ci) => {
      const condNodeId = `cond-${ci}`;
      const useQuestion = !!cond.question;

      nodes.push({
        id: condNodeId,
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
        id: `root-${condNodeId}`,
        source: 'root',
        target: condNodeId,
        style: { stroke: 'rgba(245,245,240,0.25)', strokeWidth: 1.5 },
      });

      // Individual condition outcome (slot) nodes
      for (let slotIdx = 0; slotIdx < cond.slots; slotIdx++) {
        const coId = `co-${ci}-${slotIdx}`;

        let label: string;
        let marginalPrice: number | null = null;

        if (ci === 0) {
          // Condition A: aIdx = slotIdx, any bIdx → pick first row's label part
          label = market.outcomes[slotIdx * nB]?.label?.split(' × ')[0] ?? `Outcome ${slotIdx}`;
          if (prices) {
            marginalPrice = 0;
            for (let b = 0; b < nB; b++) {
              marginalPrice += prices[slotIdx * nB + b] ?? 0;
            }
          }
        } else {
          // Condition B: bIdx = slotIdx, any aIdx → pick first column's label part
          label = market.outcomes[slotIdx]?.label?.split(' × ')[1] ?? `Outcome ${slotIdx}`;
          if (prices) {
            marginalPrice = 0;
            for (let a = 0; a < nA; a++) {
              marginalPrice += prices[a * nB + slotIdx] ?? 0;
            }
          }
        }

        const slotCombinedOutcomes = market.outcomes
          .filter(o =>
            ci === 0
              ? Math.floor(o.outcomeIndex / nB) === slotIdx
              : o.outcomeIndex % nB === slotIdx,
          )
          .map(o => ({
            outcome: o,
            combinedLabel: o.label ?? `${Math.floor(o.outcomeIndex / nB)} × ${o.outcomeIndex % nB}`,
            price: prices ? (prices[o.outcomeIndex] ?? null) : null,
          }));

        const slotInfo: SlotInfo = {
          label,
          conditionIndex: ci,
          slotIndex: slotIdx,
          price: marginalPrice,
          combinedOutcomes: slotCombinedOutcomes,
        };

        nodes.push({
          id: coId,
          type: 'condOutcome',
          position: { x: 0, y: 0 },
          data: {
            label, price: marginalPrice, conditionIndex: ci, slotIndex: slotIdx,
            onOpen: () => onSlotClick(slotInfo),
          } satisfies CondOutcomeNodeData,
          draggable: false,
        });
        edges.push({
          id: `${condNodeId}-${coId}`,
          source: condNodeId,
          target: coId,
          style: { stroke: 'rgba(245,245,240,0.18)', strokeWidth: 1 },
        });
      }
    });

    // Combined outcome leaf nodes — each gets 2 incoming edges
    market.outcomes.forEach(outcome => {
      const outId = `out-${outcome.outcomeIndex}`;
      const aIdx = Math.floor(outcome.outcomeIndex / nB);
      const bIdx = outcome.outcomeIndex % nB;
      const combinedLabel = outcome.label ?? `${aIdx} × ${bIdx}`;

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

      edges.push({
        id: `co-0-${aIdx}-${outId}`,
        source: `co-0-${aIdx}`,
        target: outId,
        style: { stroke: 'rgba(245,245,240,0.12)', strokeWidth: 1 },
      });
      edges.push({
        id: `co-1-${bIdx}-${outId}`,
        source: `co-1-${bIdx}`,
        target: outId,
        style: { stroke: 'rgba(245,245,240,0.12)', strokeWidth: 1 },
      });
    });
  } else {
    // ── Simple market: 3-level DAG (root → condition → outcomes) ────────────
    market.conditions.forEach((cond, ci) => {
      const condNodeId = `cond-${ci}`;
      nodes.push({
        id: condNodeId,
        type: 'condition',
        position: { x: 0, y: 0 },
        data: {
          conditionId: cond.id,
          conditionIndex: ci,
          slots: cond.slots,
          onOpen: () => onConditionClick(cond),
        } satisfies ConditionNodeData,
        draggable: false,
      });
      edges.push({
        id: `root-${condNodeId}`,
        source: 'root',
        target: condNodeId,
        style: { stroke: 'rgba(245,245,240,0.25)', strokeWidth: 1.5 },
      });
    });

    market.outcomes.forEach(outcome => {
      const outId = `out-${outcome.outcomeIndex}`;
      const combinedLabel = outcome.label ?? `Outcome ${outcome.outcomeIndex}`;

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

      market.conditions.forEach((_, ci) => {
        edges.push({
          id: `cond-${ci}-${outId}`,
          source: `cond-${ci}`,
          target: outId,
          style: { stroke: 'rgba(245,245,240,0.15)', strokeWidth: 1 },
        });
      });
    });
  }

  return { nodes, edges };
}

// ─── Main component ────────────────────────────────────────────────────────

export function MarketGraph({ market }: { market: MarketData }) {
  const [activeCondition, setActiveCondition] = useState<ConditionInfo | null>(null);
  const [activeOutcome, setActiveOutcome] = useState<Outcome | null>(null);
  const [activeSlot, setActiveSlot] = useState<SlotInfo | null>(null);
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

  const openPoolPanel = useCallback(() => setActiveCondition(POOL_SENTINEL), []);

  const { rawNodes, rawEdges } = useMemo(
    () => {
      const { nodes, edges } = buildGraph(
        market, prices, setActiveCondition, setActiveOutcome, openPoolPanel, setActiveSlot,
      );
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
    setActiveSlot(null);
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
            n.type === 'root'        ? '#f59e0b' :
            n.type === 'question'    ? '#14b8a6' :
            n.type === 'condition'   ? '#92400e' :
            n.type === 'condOutcome' ? '#1e3a3a' :
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
      <SlotPanel
        slot={activeSlot}
        osIndex={market.os_index}
        onClose={onClose}
        onTradeOutcome={(o) => { setActiveSlot(null); setActiveOutcome(o); }}
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
