import { useEffect, useRef, useCallback, useState } from "react";
import type { ServeEvent, ServeControl } from "../types";

interface UseRunStreamOptions {
  runId: string | null;
  onEvent: (event: ServeEvent) => void;
  onClose?: () => void;
}

export function useRunStream({ runId, onEvent, onClose }: UseRunStreamOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!runId) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/api/runs/${runId}/stream`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data as string) as ServeEvent;
        onEvent(event);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      setConnected(false);
      onClose?.();
    };

    ws.onerror = () => {
      ws.close();
    };

    return () => {
      ws.close();
    };
  }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = useCallback((ctrl: ServeControl) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(ctrl));
    }
  }, []);

  return { connected, send };
}
