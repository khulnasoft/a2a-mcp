/**
 * StdioHarness – a test utility for communicating with an MCP server
 * (or a2a-mcp wrapping one) over a stdio JSON-RPC 2.0 channel.
 *
 * Usage:
 *   const h = new StdioHarness('node', ['dist/cli.js', 'node', 'tests/fixtures/test-server.js']);
 *   await h.start();
 *   const result = await h.sendRequest('tools/list');
 *   await h.stop();
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: any;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

export class StdioHarness {
  private process: ChildProcess | null = null;
  private pendingRequests = new Map<number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private buffer = '';
  private stderrData = '';

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env?: Record<string, string>,
  ) {}

  async start(): Promise<void> {
    const env = this.env ? { ...process.env, ...this.env } : process.env;

    this.process = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    this.process.on('error', (err: Error) => {
      const failure = new Error(
        `StdioHarness: failed to spawn "${this.command} ${this.args.join(' ')}": ${err.message}`,
      );
      for (const [, pending] of this.pendingRequests) {
        pending.reject(failure);
      }
      this.pendingRequests.clear();
    });

    // Writes after the child exits emit EPIPE; keep it out of the uncaught path.
    this.process.stdin?.on('error', () => {});

    this.process.stderr?.on('data', (chunk: Buffer) => {
      this.stderrData += chunk.toString();
    });

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();

      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let message: any;
        try {
          message = JSON.parse(trimmed);
        } catch {
          // Skip non-JSON output (e.g., MCP SDK version lines)
          continue;
        }

        // Only handle JSON-RPC responses (have an id)
        if (message && typeof message.id === 'number') {
          const pending = this.pendingRequests.get(message.id);
          if (pending) {
            this.pendingRequests.delete(message.id);
            pending.resolve(message as JsonRpcResponse);
          }
        }
      }
    });

    this.process.on('close', (code) => {
      // Reject all pending requests when process exits
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error(`Process exited with code ${code}. Stderr: ${this.stderrData.slice(-500)}`));
      }
      this.pendingRequests.clear();
    });

    // Perform the MCP initialize handshake to confirm the process is ready.
    // This is deterministic (waits for an actual response) rather than relying
    // on a fixed sleep, and it also simulates a real MCP client, which must
    // send initialize before any other request.
    const init = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-harness', version: '0.0.0' },
    });
    if (init.error) {
      throw new Error(
        `StdioHarness: initialize failed: ${init.error.message}. Stderr: ${this.stderrData.slice(-500)}`,
      );
    }

    // Send the required initialized notification so the server considers the
    // session fully open. Notifications have no id and expect no response.
    this.sendNotification('notifications/initialized');

  async sendRequest(method: string, params?: any, timeoutMs = 10_000): Promise<JsonRpcResponse> {
    if (!this.process) {
      throw new Error('StdioHarness: process not started (call start() first)');
    }

    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined && { params }),
    };

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`StdioHarness: request ${id} (${method}) timed out after ${timeoutMs}ms. Stderr: ${this.stderrData.slice(-500)}`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (response) => {
          clearTimeout(timeoutId);
          resolve(response);
        },
        reject: (err) => {
          clearTimeout(timeoutId);
          reject(err);
        },
      });

      if (!this.process?.stdin) {
        this.pendingRequests.delete(id);
        clearTimeout(timeoutId);
        reject(new Error('StdioHarness: process stdin is not available'));
        return;
      }
      this.process.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  /**
   * Send a JSON-RPC notification (no id, no response expected).
   */
  sendNotification(method: string, params?: any): void {
    if (!this.process?.stdin) return;
    const notification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined && { params }),
    };
    this.process.stdin.write(JSON.stringify(notification) + '\n');
  }

  /**
   * Convenience: call tools/list and return the result.
   */
  async listTools(): Promise<{ tools: any[] }> {
    const resp = await this.sendRequest('tools/list');
    if (resp.error) {
      throw new Error(`tools/list error: ${resp.error.message}`);
    }
    return resp.result;
  }

  /**
   * Convenience: call tools/call and return the result.
   */
  async callTool(name: string, args: Record<string, any> = {}): Promise<{ content: any[]; isError?: boolean }> {
    const resp = await this.sendRequest('tools/call', { name, arguments: args });
    if (resp.error) {
      throw new Error(`tools/call(${name}) error: ${resp.error.message}`);
    }
    return resp.result;
  }

  /**
   * Parse text content returned by a a2a-mcp meta-tool.
   */
  parseToolText(result: { content: any[] }): any {
    const text = result.content.find((c: any) => c.type === 'text')?.text;
    if (text === undefined) throw new Error('No text content in result');
    return JSON.parse(text);
  }

  get stderr(): string {
    return this.stderrData;
  }

  async stop(): Promise<void> {
    if (!this.process) return;

    const proc = this.process;
    this.process = null;

    await new Promise<void>((resolve) => {
      // Safety timeout: force-kill after 2 s if SIGTERM doesn't work
      const forceKill = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 2_000);

      proc.once('close', () => {
        clearTimeout(forceKill);
        resolve();
      });

      proc.kill('SIGTERM');
    });
  }

  sendSignal(signal: NodeJS.Signals): void {
    this.process?.kill(signal);
  }
}

/**
 * Returns the absolute path to the built CLI entry point.
 */
export function cliPath(): string {
  return path.resolve(__dirname, '../../dist/cli.js');
}

/**
 * Returns the absolute path to the test fixture server.
 */
export function testServerPath(): string {
  return path.resolve(__dirname, '../fixtures/test-server.js');
}

/**
 * Returns the absolute path to the strict test fixture server.
 * This server requires the MCP initialize handshake before accepting requests.
 */
export function strictServerPath(): string {
  return path.resolve(__dirname, '../fixtures/strict-server.js');
}
