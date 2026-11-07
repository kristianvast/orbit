/** A session owns one upstream connection; mock and live transports speak the same JSON frames. */
export interface VoiceTransport {
  connect(receive: (frame: unknown) => void, closed: (code: number) => void): Promise<void>;
  send(frame: unknown): void;
  close(): void;
}

export class LiveVoiceTransport implements VoiceTransport {
  private socket: WebSocket | null = null;

  constructor(
    private readonly endpoint: { readonly url: string; readonly headers?: Record<string, string> },
  ) {}

  connect(receive: (frame: unknown) => void, closed: (code: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.endpoint.url, { headers: this.endpoint.headers });
      this.socket = socket;
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("Voice connection timed out."));
      }, 15000);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Could not connect to the voice service."));
      };
      socket.onclose = (event) => {
        clearTimeout(timer);
        closed(event.code);
      };
      socket.onmessage = (event) => {
        try {
          const frame: unknown = JSON.parse(String(event.data));
          receive(frame);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          socket.close(1002, "Invalid voice JSON");
        }
      };
    });
  }

  send(frame: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}
