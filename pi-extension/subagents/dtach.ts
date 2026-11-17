/**
 * dtach surface layer: the backend for containers, where there is no tmux.
 *
 * It offers the same surface API as tmux.ts. A "surface" is the path of the child's dtach
 * socket, `<run dir>/sub-<id>.sock` (run dir `/run/saga` in a container). Nothing runs when a
 * surface is created: the child starts in sendLongCommand, which runs the launch script under
 * `dtach -n`. No tmux call and no command line ever reaches the host. announceSurface then
 * tells the saga API the child's id; the host checks the id and the socket itself and opens
 * the pane that attaches to it.
 *
 * Exit protocol: the launch script writes the child's exit code to `sub-<id>.exit-code` (see
 * withExitMarker). A socket that is gone with no exit-code file means the child was killed,
 * reported as 143, as agent-start does.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { interpretExitSidecar, shellEscape } from "./tmux.ts";
import type { PollResult } from "./tmux.ts";

const DEFAULT_RUN_DIR = "/run/saga";
const CHILD_ID_PATTERN = /^[a-z0-9-]{1,32}$/;
const KILLED_EXIT_CODE = 143;
/** After start the socket may take a moment to appear; do not call that a kill. */
const SOCKET_GRACE_MS = 5000;
const PID_WAIT_MS = 3000;
const ANNOUNCE_TIMEOUT_MS = 10_000;

function runDir(): string {
  return process.env.SAGA_RUN_DIR || DEFAULT_RUN_DIR;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. The dtach backend needs SAGA_API_URL, SAGA_THREAD and ` +
        `SAGA_AGENT_KEY from the saga launcher.`,
    );
  }
  return value;
}

// ── Availability ──

function dtachOnPath(): boolean {
  try {
    execFileSync("sh", ["-c", "command -v dtach"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** True in a saga container: the launcher's variables are set and dtach is installed. */
export function isDtachAvailable(): boolean {
  return (
    !!process.env.SAGA_API_URL &&
    !!process.env.SAGA_THREAD &&
    !!process.env.SAGA_AGENT_KEY &&
    dtachOnPath()
  );
}

export function dtachSetupHint(): string {
  return (
    "Install dtach and set SAGA_API_URL, SAGA_THREAD and SAGA_AGENT_KEY " +
    "(the saga launcher does this), or set PI_SUBAGENT_MUX=tmux and run pi inside tmux."
  );
}

// ── Paths ──

/** `<dir>/sub-<id>.sock` to `<id>`; throws for a path this backend did not make. */
export function childIdFromSurface(surface: string): string {
  const match = basename(surface).match(/^sub-(.+)\.sock$/);
  if (!match || !CHILD_ID_PATTERN.test(match[1])) {
    throw new Error(`Not a dtach surface: ${surface}`);
  }
  return match[1];
}

function siblingPath(surface: string, suffix: string): string {
  return join(dirname(surface), `sub-${childIdFromSurface(surface)}.${suffix}`);
}

/** A unique id that passes the API's `^[a-z0-9-]{1,32}$`: at most 20 + 1 + 6 characters. */
function newChildId(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .slice(0, 20)
      .replace(/-+$/, "") || "child";
  return `${slug}-${Math.random().toString(16).slice(2, 8).padEnd(6, "0")}`;
}

// ── Surface primitives ──

/** Reserve a socket path for a new child. Nothing runs until sendLongCommand. */
export function createSurface(name: string): string {
  const dir = runDir();
  if (!existsSync(dir)) {
    throw new Error(`${dir} does not exist; the container image should create it.`);
  }
  return join(dir, `sub-${newChildId(name)}.sock`);
}

export function createSurfaceSplit(name: string): string {
  return createSurface(name);
}

/**
 * Append the exit-code write to a child's command. The code goes to a temporary file first and
 * is renamed, so a reader never sees a half-written file.
 */
export function withExitMarker(surface: string, command: string): string {
  const exitFile = shellEscape(siblingPath(surface, "exit-code"));
  const tmpFile = shellEscape(siblingPath(surface, "exit-code.tmp"));
  return `${command}; code=$?; echo "$code" > ${tmpFile} && mv ${tmpFile} ${exitFile}`;
}

/**
 * Write the child's launch script and start it under dtach. `dtach -n` returns at once and
 * the child keeps running. The script records its pid so closeSurface can stop it.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath = options?.scriptPath ?? siblingPath(surface, "sh");
  mkdirSync(dirname(scriptPath), { recursive: true });
  const parts = ["#!/bin/bash"];
  if (options?.scriptPreamble) parts.push(options.scriptPreamble.trimEnd());
  parts.push(`echo $$ > ${shellEscape(siblingPath(surface, "pid"))}`, command);
  writeFileSync(scriptPath, parts.join("\n") + "\n", { mode: 0o755 });
  try {
    execFileSync("dtach", ["-n", surface, "-r", "winch", "bash", scriptPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error: any) {
    throw new Error(
      `dtach could not start the child at ${surface}: ${error?.stderr || error?.message}`,
    );
  }
  waitForPidFile(surface);
  return scriptPath;
}

/** Block until the launch script has recorded its pid, so a kill right after start works. */
function waitForPidFile(surface: string): void {
  const pidFile = siblingPath(surface, "pid");
  const deadline = Date.now() + PID_WAIT_MS;
  while (!existsSync(pidFile)) {
    if (Date.now() > deadline) {
      throw new Error(
        `The child at ${surface} did not start: no ${pidFile} after ${PID_WAIT_MS} ms`,
      );
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

/**
 * Tell the saga API the child exists so the host can open a pane for it. If the call fails
 * the child is stopped: a child nobody can attach to cannot be prompted.
 */
export async function announceSurface(surface: string): Promise<void> {
  const id = childIdFromSurface(surface);
  const url = `${requireEnv("SAGA_API_URL")}/v1/threads/${requireEnv("SAGA_THREAD")}/children`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requireEnv("SAGA_AGENT_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(ANNOUNCE_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    }
  } catch (error: any) {
    closeSurface(surface);
    throw new Error(
      `Could not announce subagent ${id} to ${url}: ${error?.message ?? String(error)}. ` +
        `The child was stopped.`,
    );
  }
}

/**
 * Type a line into a running child, as a person at the attached pane would: the text, then
 * Enter. `dtach -p` copies stdin to the session.
 */
export function sendCommand(surface: string, command: string): void {
  childIdFromSurface(surface);
  if (!existsSync(surface)) {
    throw new Error(`Subagent socket ${surface} is gone; the child has ended.`);
  }
  for (const input of [command, "\r"]) {
    execFileSync("dtach", ["-p", surface], { input, encoding: "utf8" });
  }
}

/** A dtach session has no screen to read. Callers fall back to the session file. */
export function readScreen(): string {
  return "";
}

export async function readScreenAsync(): Promise<string> {
  return "";
}

function readPid(surface: string): number | null {
  try {
    const pid = parseInt(readFileSync(siblingPath(surface, "pid"), "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Stop the child: SIGTERM to its process group (the launch script leads the dtach session, so
 * this reaches pi too). Its dtach session ends and the host pane goes with it. A child that
 * already ended is not an error.
 */
export function closeSurface(surface: string): void {
  const pid = readPid(surface);
  if (pid === null) {
    if (existsSync(surface)) {
      const pidFile = siblingPath(surface, "pid");
      throw new Error(`Cannot stop the child at ${surface}: no usable pid file ${pidFile}`);
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error: any) {
    if (error?.code !== "ESRCH") throw error;
  }
  rmSync(siblingPath(surface, "pid"), { force: true });
}

// ── Exit polling ──

function readSidecar(sessionFile: string | undefined): any | null {
  if (!sessionFile) return null;
  const exitFile = `${sessionFile}.exit`;
  try {
    if (!existsSync(exitFile)) return null;
    const data = JSON.parse(readFileSync(exitFile, "utf-8"));
    rmSync(exitFile, { force: true });
    return data;
  } catch {
    return null;
  }
}

function readExitCode(surface: string): number | null {
  try {
    const code = parseInt(readFileSync(siblingPath(surface, "exit-code"), "utf8").trim(), 10);
    return Number.isInteger(code) ? code : null;
  } catch {
    return null;
  }
}

/**
 * The exit code if the child ended, else null. The exit-code file is written before the
 * socket goes, so it is read after the socket check: socket gone and no file means killed.
 */
function endedExitCode(surface: string, state: { sawSocket: boolean; startedAt: number }) {
  const socketExists = existsSync(surface);
  if (socketExists) state.sawSocket = true;
  const code = readExitCode(surface);
  if (code !== null) {
    rmSync(siblingPath(surface, "exit-code"), { force: true });
    return code;
  }
  const inGrace = !state.sawSocket && Date.now() - state.startedAt < SOCKET_GRACE_MS;
  return socketExists || inGrace ? null : KILLED_EXIT_CODE;
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const state = { sawSocket: false, startedAt: Date.now() };
  for (;;) {
    if (signal.aborted) throw new Error("Aborted while waiting for subagent to finish");

    const sidecar = readSidecar(options.sessionFile);
    if (sidecar) return interpretExitSidecar(sidecar);

    if (options.sentinelFile && existsSync(options.sentinelFile)) {
      return { reason: "sentinel", exitCode: 0 };
    }

    const code = endedExitCode(surface, state);
    if (code !== null) return { reason: "sentinel", exitCode: code };

    options.onTick?.(Math.floor((Date.now() - state.startedAt) / 1000));
    await sleepUnlessAborted(options.interval, signal);
  }
}
