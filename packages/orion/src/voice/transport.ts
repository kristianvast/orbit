import { AccountError } from "../services/account";

/** Text frames stay opaque between the local SDK socket and Core. */
export interface VoiceTransport {
  connect(receive: (frame: string) => void, closed: (code: number) => void): Promise<void>;
  send(frame: string): void;
  close(): void;
}

export class LiveVoiceTransport implements VoiceTransport {
  private socket: WebSocket | null = null;
  constructor(
    private readonly endpoint: { readonly url: string; readonly headers?: Record<string, string> },
  ) {}

  connect(receive: (frame: string) => void, closed: (code: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.endpoint.url, { headers: this.endpoint.headers });
      this.socket = socket;
      let opened = false;
      const timer = setTimeout(() => {
        socket.close();
        reject(new AccountError("timeout", "Voice connection timed out."));
      }, 15000);
      socket.onopen = () => {
        clearTimeout(timer);
        opened = true;
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new AccountError("not_ready", "Could not connect to the voice service."));
      };
      socket.onclose = (event) => {
        clearTimeout(timer);
        if (!opened)
          reject(new AccountError("not_ready", "Voice service closed before connecting."));
        closed(event.code);
      };
      socket.onmessage = (event) => receive(String(event.data));
    });
  }

  send(frame: string): void {
    this.socket?.send(frame);
  }
  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}
