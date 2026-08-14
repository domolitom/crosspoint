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
  const [graph, setGraph] = useState<Graph | null>(null);
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
          setGraph(msg.graph);
          setDiagram(msg.diagram);
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

  const sendOp = useCallback((op: GraphOp) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'op', op }));
    }
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
    graph,
    diagram,
    diagrams,
    connected,
    error,
    sendOp,
    switchDiagram,
    createDiagram,
  };
}
