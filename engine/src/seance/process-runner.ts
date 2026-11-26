/**
 * Process-spawn abstraction for the Runner (task 10.4).
 *
 * The Runner never calls `child_process` itself; it takes a `ProcessRunner`, so tests can script
 * forge's stdout, stderr, exit code and files without forge. `createProcessRunner` is the real
 * implementation: no shell, own process group (so forge's children die with it), SIGTERM at the
 * deadline and SIGKILL `killGraceMs` later (5 s by default).
 */
import { spawn } from "node:child_process";

export interface ProcessRunOptions {
  cwd: string;
  /** Variables ADDED to the environment of the child (the real runner merges them over `process.env`). */
  env: Record<string, string>;
  /** Wall-clock budget in ms. When it elapses the process group gets SIGTERM, then SIGKILL after the grace. */
  timeoutMs: number;
  /** Aborting kills the process the same way, but is not reported as `timedOut`. */
  signal?: AbortSignal;
}

export interface ProcessResult {
  /** Exit code; `null` when the process was killed by a signal or could not be started. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the process was killed because `timeoutMs` elapsed. */
  timedOut: boolean;
}

export interface ProcessRunner {
  run(cmd: string, args: string[], opts: ProcessRunOptions): Promise<ProcessResult>;
}

/** Grace between SIGTERM and SIGKILL (design: forge stops within 5 seconds). */
export const KILL_GRACE_MS = 5_000;

export function createProcessRunner(config: { killGraceMs?: number } = {}): ProcessRunner {
  const grace = config.killGraceMs ?? KILL_GRACE_MS;
  return {
    run(cmd, args, opts) {
      return new Promise<ProcessResult>((resolve) => {
        const out: Buffer[] = [];
        const errChunks: Buffer[] = [];
        let timedOut = false;
        let settled = false;
        let termTimer: NodeJS.Timeout | undefined;
        let killTimer: NodeJS.Timeout | undefined;

        let child;
        try {
          child = spawn(cmd, args, {
            cwd: opts.cwd,
            env: { ...process.env, ...opts.env },
            stdio: ["ignore", "pipe", "pipe"],
            detached: true, // own process group: kill(-pid) reaches forge's children (solc, anvil-like helpers)
          });
        } catch (e) {
          resolve({ code: null, stdout: "", stderr: `could not start ${cmd}: ${(e as Error).message}`, timedOut: false });
          return;
        }

        const signalGroup = (sig: NodeJS.Signals): void => {
          const pid = child.pid;
          if (pid === undefined) return;
          try {
            process.kill(-pid, sig);
          } catch {
            try {
              child.kill(sig);
            } catch {
              // already gone
            }
          }
        };
        const terminate = (): void => {
          signalGroup("SIGTERM");
          killTimer ??= setTimeout(() => signalGroup("SIGKILL"), grace);
        };
        const finish = (code: number | null, extraErr = ""): void => {
          if (settled) return;
          settled = true;
          if (termTimer) clearTimeout(termTimer);
          if (killTimer) clearTimeout(killTimer);
          // The leader is gone; make sure nothing it started survives.
          if (timedOut || opts.signal?.aborted) signalGroup("SIGKILL");
          opts.signal?.removeEventListener("abort", onAbort);
          resolve({
            code,
            stdout: Buffer.concat(out).toString("utf8"),
            stderr: Buffer.concat(errChunks).toString("utf8") + extraErr,
            timedOut,
          });
        };
        const onAbort = (): void => terminate();

        child.stdout?.on("data", (d: Buffer) => out.push(d));
        child.stderr?.on("data", (d: Buffer) => errChunks.push(d));
        child.on("error", (e) => finish(null, `could not run ${cmd}: ${e.message}`));
        child.on("close", (code) => finish(code));

        termTimer = setTimeout(
          () => {
            timedOut = true;
            terminate();
          },
          Math.max(0, opts.timeoutMs),
        );
        if (opts.signal) {
          if (opts.signal.aborted) terminate();
          else opts.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    },
  };
}
