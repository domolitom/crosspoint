import type { Graph, GraphOp } from '@crosspoint/core';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface DiagramSummary {
  name: string;
  nodes: number;
  edges: number;
  rev: number;
}

type ServerMessage =
  | { type: 'hello'; clientId: string }
  | { type: 'graph'; diagram: string; graph: Graph; origin?: string }
  | { type: 'diagrams'; active: string; diagrams: DiagramSummary[] }
  | { type: 'error'; error: string };

/**
 * Live connection to the graph the server owns.
 *
 * The socket is the only channel: every local mutation is sent as an op and comes back
 * as authoritative state. The canvas never writes the file and never invents a rev.
 */
export function useGraph() {
  /**
   * Every diagram we have heard about, by name.
   *
   * Not just the active one: a lens panel is live on a diagram that is by definition not
   * active, and the server broadcasts all of them. Keeping the map here means an edit made
   * in a panel — or by an agent working in a diagram nobody is looking at — lands without
   * a second channel.
   */
  const [graphs, setGraphs] = useState<Record<string, Graph>>({});
  const [diagram, setDiagram] = useState<string | null>(null);
  const [diagrams, setDiagrams] = useState<DiagramSummary[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const clientId = useRef<string | null>(null);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${location.host}/ws`);
      socket.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data) as ServerMessage;
        if (msg.type === 'hello') clientId.current = msg.clientId;
        else if (msg.type === 'graph') {
          // Store by name and do NOT treat this as a switch: a push for a diagram open in
          // a panel would otherwise drag the main canvas over to it.
          setGraphs((prev) => ({ ...prev, [msg.diagram]: msg.graph }));
        } else if (msg.type === 'diagrams') {
          setDiagrams(msg.diagrams);
          setDiagram(msg.active);
        } else if (msg.type === 'error') setError(msg.error);
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1000);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      socket.current?.close();
    };
  }, []);

  /** `diagram` targets one that is not active — a lens panel's edits go there. */
  const sendOp = useCallback((op: GraphOp, target?: string) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'op', op, diagram: target }));
    }
  }, []);

  /**
   * Step a diagram's history. Goes over the socket like an op, so the server attributes it
   * to the canvas rather than to an agent, and every connected client sees the result.
   */
  const revert = useCallback((direction: 'undo' | 'redo', target?: string) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: direction, diagram: target }));
    }
  }, []);

  /**
   * Seed a diagram we have not been pushed yet.
   *
   * The socket only sends the active diagram on connect, so opening a panel needs one
   * fetch to get started; broadcasts keep it current from then on.
   */
  const loadDiagram = useCallback(async (name: string) => {
    const res = await fetch(`/api/graph?diagram=${encodeURIComponent(name)}`);
    if (!res.ok) {
      setError(((await res.json()) as { error?: string }).error ?? `Cannot open "${name}"`);
      return false;
    }
    const graph = (await res.json()) as Graph;
    setGraphs((prev) => ({ ...prev, [name]: graph }));
    return true;
  }, []);

  /**
   * Diagram management goes over HTTP rather than the socket.
   *
   * These are not ops: creating or switching changes nothing inside a diagram, so it has
   * no rev and no place in the change feed. The server broadcasts the result, which is
   * what actually updates this hook — the same "server is the only authority" rule the
   * ops path follows.
   */
  const switchDiagram = useCallback(async (name: string) => {
    const res = await fetch('/api/diagrams/active', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) setError(((await res.json()) as { error?: string }).error ?? 'Switch failed');
  }, []);

  const createDiagram = useCallback(
    async (name: string) => {
      const res = await fetch('/api/diagrams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        setError(((await res.json()) as { error?: string }).error ?? 'Create failed');
        return;
      }
      // Creating deliberately does not switch on the server, so do it here — someone who
      // just made a diagram wants to be looking at it.
      await switchDiagram(name);
    },
    [switchDiagram],
  );

  return {
    /** The active diagram's graph — what the main canvas renders. */
    graph: diagram ? (graphs[diagram] ?? null) : null,
    graphs,
    diagram,
    diagrams,
    connected,
    error,
    setError,
    sendOp,
    revert,
    loadDiagram,
    switchDiagram,
    createDiagram,
  };
}
