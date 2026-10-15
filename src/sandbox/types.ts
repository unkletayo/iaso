export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  timeoutSec?: number;
  cwd?: string;
}

export interface Sandbox {
  start(): Promise<void>;
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /** Unified diff of everything changed under /repo since `start()`, including new files. */
  diff(): Promise<string>;
  setNetwork(enabled: boolean): Promise<void>;
  /** Idempotent. Always safe to call, even after a failed or partial `start()`. */
  destroy(): Promise<void>;
}
