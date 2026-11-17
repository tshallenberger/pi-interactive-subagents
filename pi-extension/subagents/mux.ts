/**
 * Picks the surface backend: tmux (the default on a host) or dtach (a saga container).
 *
 * `PI_SUBAGENT_MUX=tmux|dtach` forces one. Otherwise dtach is used when the saga launcher's
 * `SAGA_API_URL` and `SAGA_THREAD` are set, and tmux in every other case. The choice is made
 * on each call, so it follows the environment of the running process.
 */
import * as dtach from "./dtach.ts";
import * as tmux from "./tmux.ts";
import type { PollResult } from "./tmux.ts";

export type { PollResult };
export { shellEscape } from "./tmux.ts";

export type MuxBackend = "tmux" | "dtach";

export function selectBackend(env: NodeJS.ProcessEnv = process.env): MuxBackend {
  const forced = env.PI_SUBAGENT_MUX;
  if (forced === "tmux" || forced === "dtach") return forced;
  if (forced) {
    throw new Error(`PI_SUBAGENT_MUX must be "tmux" or "dtach", got "${forced}".`);
  }
  return env.SAGA_API_URL && env.SAGA_THREAD ? "dtach" : "tmux";
}

export function isMuxAvailable(): boolean {
  return selectBackend() === "dtach" ? dtach.isDtachAvailable() : tmux.isMuxAvailable();
}

export function muxSetupHint(): string {
  return selectBackend() === "dtach" ? dtach.dtachSetupHint() : tmux.muxSetupHint();
}

export function createSurface(name: string): string {
  return selectBackend() === "dtach" ? dtach.createSurface(name) : tmux.createSurface(name);
}

/** The command that makes the launch script report its exit code. */
export function withExitMarker(surface: string, command: string): string {
  return selectBackend() === "dtach"
    ? dtach.withExitMarker(surface, command)
    : `${command}; echo '__SUBAGENT_DONE_'$?'__'`;
}

export function sendCommand(surface: string, command: string): void {
  if (selectBackend() === "dtach") dtach.sendCommand(surface, command);
  else tmux.sendCommand(surface, command);
}

export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  return selectBackend() === "dtach"
    ? dtach.sendLongCommand(surface, command, options)
    : tmux.sendLongCommand(surface, command, options);
}

/** Tell the saga API about a started child. Does nothing under tmux. */
export async function announceSurface(surface: string): Promise<void> {
  if (selectBackend() === "dtach") await dtach.announceSurface(surface);
}

/** Release every child still registered with the saga API. Does nothing under tmux. */
export async function releaseAllSurfaces(): Promise<void> {
  if (selectBackend() === "dtach") await dtach.releaseAllChildren();
}

export function readScreen(surface: string, lines = 50): string {
  return selectBackend() === "dtach" ? dtach.readScreen() : tmux.readScreen(surface, lines);
}

export function closeSurface(surface: string): void {
  if (selectBackend() === "dtach") dtach.closeSurface(surface);
  else tmux.closeSurface(surface);
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
  return selectBackend() === "dtach"
    ? dtach.pollForExit(surface, signal, options)
    : tmux.pollForExit(surface, signal, options);
}
