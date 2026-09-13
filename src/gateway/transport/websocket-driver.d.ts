declare module "websocket-driver" {
  import type { Buffer } from "node:buffer";
  interface Driver {
    readonly io: { on(event: "data", listener: (data: Buffer) => void): void };
    on(event: "open", listener: () => void): void;
    on(event: "error", listener: (error: Error) => void): void;
    on(
      event: "message",
      listener: (event: { readonly data: string | Buffer }) => void,
    ): void;
    on(
      event: "close",
      listener: (event: {
        readonly code: number;
        readonly reason: string;
      }) => void,
    ): void;
    setHeader(name: string, value: string): void;
    start(): boolean;
    parse(data: Buffer): void;
    text(message: string): boolean;
    binary(message: Buffer): boolean;
    close(reason?: string, code?: number): boolean;
  }
  const driver: {
    client(url: string, options?: { maxLength?: number }): Driver;
  };
  export default driver;
}
