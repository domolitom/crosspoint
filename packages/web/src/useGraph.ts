import type { Graph, GraphOp } from '@crosspoint/core';
import { useCallback, useEffect, useRef, useState } from 'react';

type ServerMessage =
  | { type: 'hello'; clientId: string }
  | { type: 'graph'; graph: Graph; origin?: string }
  | { type: 'error'; error: string };

/**
 * Live connection to the graph the server owns.
 *
 * The socket is the only channel: every local mutation is sent as an op and comes back
 * as authoritative state. The canvas never writes the file and never invents a rev.
 */
export function useGraph() {
  const [graph, setGraph] = useState<Graph | null>(null);
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
        else if (msg.type === 'graph') setGraph(msg.graph);
        else if (msg.type === 'error') setError(msg.error);
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

  return { graph, connected, error, sendOp };
}
