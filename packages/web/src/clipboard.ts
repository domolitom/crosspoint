import { copySelection, pasteOp, type Clip, type Graph, type GraphOp } from '@crosspoint/core';
import { useEffect, useRef, type RefObject } from 'react';

/** Each paste lands this much further down and right than the last, in flow units. */
const OFFSET = 30;

// Module scope so a copy in one canvas pastes into another, or into another diagram.
let clip: Clip | null = null;
let pastes = 0;
// The canvas last pointed at owns the shortcuts; `null` falls back to the main one.
let active: symbol | null = null;

const typing = () => {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
};

interface Options {
  wrapper: RefObject<HTMLDivElement | null>;
  graph: Graph | null;
  main: boolean;
  selectedNodes: RefObject<string[]>;
  emit: (op: GraphOp) => void;
  /** Select exactly these, once the server has pushed the paste back. */
  select: (nodes: Set<string>, edges: Set<string>) => void;
}

/** Cmd/Ctrl+C and Cmd/Ctrl+V for one canvas. */
export function useClipboard({ wrapper, graph, main, selectedNodes, emit, select }: Options) {
  const token = useRef(Symbol('canvas')).current;
  const latest = useRef(graph);
  latest.current = graph;
  const pending = useRef<{ nodes: Set<string>; edges: Set<string> } | null>(null);

  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const claim = () => (active = token);
    el.addEventListener('pointerdown', claim, true);
    return () => {
      el.removeEventListener('pointerdown', claim, true);
      if (active === token) active = null;
    };
  }, [wrapper, token]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== 'c' && key !== 'v') return;
      if (typing() || !(active === token || (active === null && main))) return;
      const graph = latest.current;
      if (!graph) return;

      if (key === 'c') {
        const copied = copySelection(graph, selectedNodes.current ?? []);
        if (!copied) return;
        event.preventDefault();
        clip = copied;
        pastes = 0;
        return;
      }

      if (!clip) return;
      event.preventDefault();
      pastes += 1;
      pending.current = {
        nodes: new Set(graph.nodes.map((n) => n.id)),
        edges: new Set(graph.edges.map((e) => e.id)),
      };
      emit(pasteOp(clip, OFFSET * pastes, OFFSET * pastes));
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [token, main, selectedNodes, emit]);

  // No optimistic copy: the server names the new nodes, so select them when they arrive.
  useEffect(() => {
    const before = pending.current;
    if (!before || !graph) return;
    const nodes = new Set(graph.nodes.filter((n) => !before.nodes.has(n.id)).map((n) => n.id));
    if (nodes.size === 0) return;
    pending.current = null;
    const edges = new Set(graph.edges.filter((e) => !before.edges.has(e.id)).map((e) => e.id));
    select(nodes, edges);
  }, [graph, select]);
}
