/**
 * Tests for the dtach backend and the backend switch. A fake `dtach` on PATH stands in for the
 * real binary: `-n` runs the script in its own session (as dtach does) and removes the socket
 * when the script ends; `-p` records what was pushed. Argv of every call goes to a log.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  announceSurface,
  childIdFromSurface,
  closeSurface,
  createSurface,
  pollForExit,
  sendCommand,
  sendLongCommand,
  withExitMarker,
} from "../pi-extension/subagents/dtach.ts";
import * as mux from "../pi-extension/subagents/mux.ts";

const FAKE_DTACH = `#!/bin/bash
echo "$*" >> "$FAKE_DTACH_LOG"
if [ "$1" = "-n" ]; then
  sock="$2"; shift 4
  touch "$sock"
  ( perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' "$@" >/dev/null 2>&1; rm -f "$sock" ) >/dev/null 2>&1 </dev/null &
elif [ "$1" = "-p" ]; then
  printf 'PUSH:%s\\n' "$(cat | od -An -c | tr -s ' ')" >> "$FAKE_DTACH_LOG"
fi
`;

const ENV_KEYS = [
  "PATH",
  "SAGA_RUN_DIR",
  "SAGA_API_URL",
  "SAGA_THREAD",
  "SAGA_AGENT_KEY",
  "PI_SUBAGENT_MUX",
  "FAKE_DTACH_LOG",
];
const savedEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
let root: string;
let runDir: string;
let log: string;

function dtachLog(): string {
  return existsSync(log) ? readFileSync(log, "utf8") : "";
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const poll = (surface: string, extra = {}) =>
  pollForExit(surface, new AbortController().signal, { interval: 20, ...extra });

/** Start a child that runs `body`, with the exit marker, through the fake dtach. */
function start(name: string, body: string): string {
  const surface = createSurface(name);
  sendLongCommand(surface, withExitMarker(surface, body), {
    scriptPath: join(root, "scripts", `${childIdFromSurface(surface)}.sh`),
  });
  return surface;
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "dtach-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "dtach"), FAKE_DTACH, { mode: 0o755 });
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.PATH = `${bin}:${process.env.PATH}`;
});

after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  globalThis.fetch = realFetch;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  runDir = mkdtempSync(join(root, "run-"));
  log = join(runDir, "dtach.log");
  process.env.SAGA_RUN_DIR = runDir;
  process.env.FAKE_DTACH_LOG = log;
  process.env.SAGA_API_URL = "http://api.test:7777";
  process.env.SAGA_THREAD = "thread-x";
  process.env.SAGA_AGENT_KEY = "key-1";
  delete process.env.PI_SUBAGENT_MUX;
  globalThis.fetch = realFetch;
});

describe("dtach surface ids", () => {
  it("makes unique ids that match the API pattern, whatever the name", () => {
    const names = ["scout", "Scout: ../x;rm", "", "a".repeat(80), "---", "ünï cödé"];
    const seen = new Set<string>();
    for (const name of names) {
      const surface = createSurface(name);
      const id = childIdFromSurface(surface);
      assert.match(id, /^[a-z0-9-]{1,32}$/, `name ${JSON.stringify(name)}`);
      assert.equal(surface, join(runDir, `sub-${id}.sock`));
      seen.add(id);
    }
    assert.equal(seen.size, names.length);
  });

  it("fails with the missing directory named", () => {
    process.env.SAGA_RUN_DIR = join(runDir, "missing");
    assert.throws(() => createSurface("x"), /missing does not exist/);
  });

  it("rejects a path that is not a child socket", () => {
    for (const bad of ["/run/saga/agent.sock", "/run/saga/sub-.sock", "/x/sub-A;b.sock"]) {
      assert.throws(() => childIdFromSurface(bad), /Not a dtach surface/, bad);
    }
  });
});

describe("dtach start and exit", () => {
  it("starts the script with exactly dtach -n sock -r winch bash script", () => {
    const surface = start("scout", "true");
    const script = join(root, "scripts", `${childIdFromSurface(surface)}.sh`);
    assert.equal(dtachLog().split("\n")[0], `-n ${surface} -r winch bash ${script}`);
    assert.match(readFileSync(script, "utf8"), /^#!\/bin\/bash\necho \$\$ > '.*\.pid'\n/);
  });

  it("reports the exit code the script wrote", async () => {
    const surface = start("scout", "sh -c 'exit 3'");
    assert.deepEqual(await poll(surface), { reason: "sentinel", exitCode: 3 });
  });

  it("reports 0 for a clean exit and removes the exit-code file", async () => {
    const surface = start("scout", "true");
    assert.deepEqual(await poll(surface), { reason: "sentinel", exitCode: 0 });
    const id = childIdFromSurface(surface);
    assert.equal(existsSync(join(runDir, `sub-${id}.exit-code`)), false);
  });

  it("treats a gone socket with no exit-code file as killed (143)", async () => {
    const surface = createSurface("scout");
    writeFileSync(surface, "");
    const pending = poll(surface);
    await new Promise((r) => setTimeout(r, 60));
    rmSync(surface);
    assert.deepEqual(await pending, { reason: "sentinel", exitCode: 143 });
  });

  it("does not call a child killed before its socket has appeared", async () => {
    const surface = createSurface("scout");
    const abort = new AbortController();
    const pending = pollForExit(surface, abort.signal, { interval: 20 });
    setTimeout(() => abort.abort(), 150);
    await assert.rejects(pending, /Aborted/);
  });

  it("prefers the exit-code file over a gone socket", async () => {
    const surface = createSurface("scout");
    const id = childIdFromSurface(surface);
    writeFileSync(join(runDir, `sub-${id}.exit-code`), "7\n");
    assert.deepEqual(await poll(surface), { reason: "sentinel", exitCode: 7 });
  });

  it("reads the error sidecar and the Claude sentinel file", async () => {
    const surface = createSurface("scout");
    const session = join(root, "session.jsonl");
    writeFileSync(`${session}.exit`, JSON.stringify({ type: "error", errorMessage: "boom" }));
    assert.deepEqual(await poll(surface, { sessionFile: session }), {
      reason: "error",
      exitCode: 1,
      errorMessage: "boom",
    });
    const sentinel = join(root, "sentinel");
    writeFileSync(sentinel, "");
    assert.deepEqual(await poll(surface, { sentinelFile: sentinel }), {
      reason: "sentinel",
      exitCode: 0,
    });
  });

  it("calls onTick while waiting", async () => {
    const surface = start("scout", "sleep 0.3");
    let ticks = 0;
    await poll(surface, { onTick: () => ticks++ });
    assert.ok(ticks > 0);
  });

  it("fails with the pid file named when the script never starts", () => {
    process.env.PATH = `${join(root, "nobin")}:/usr/bin:/bin`;
    mkdirSync(join(root, "nobin"), { recursive: true });
    writeFileSync(join(root, "nobin", "dtach"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
    const surface = createSurface("scout");
    assert.throws(
      () => sendLongCommand(surface, "true", { scriptPath: join(root, "s.sh") }),
      /did not start: no .*\.pid/,
    );
    process.env.PATH = `${join(root, "bin")}:${process.env.PATH}`;
  });

  it("reports dtach's own failure with the socket named", () => {
    mkdirSync(join(root, "nobin"), { recursive: true });
    writeFileSync(join(root, "nobin", "dtach"), "#!/bin/bash\necho nope >&2\nexit 1\n", {
      mode: 0o755,
    });
    process.env.PATH = `${join(root, "nobin")}:/usr/bin:/bin`;
    const surface = createSurface("scout");
    assert.throws(
      () => sendLongCommand(surface, "true", { scriptPath: join(root, "s.sh") }),
      /dtach could not start the child at .*nope/s,
    );
    process.env.PATH = `${join(root, "bin")}:${process.env.PATH}`;
  });
});

describe("dtach closeSurface", () => {
  it("stops a running child, pi and its wrapper both, and reads as killed", async () => {
    const pidFile = join(runDir, "inner.pid");
    const surface = start("scout", `sh -c 'echo $$ > ${pidFile}; sleep 30'`);
    await until(() => existsSync(pidFile));
    const inner = parseInt(readFileSync(pidFile, "utf8"), 10);
    closeSurface(surface);
    await until(() => !existsSync(surface));
    await until(() => {
      try {
        process.kill(inner, 0);
        return false;
      } catch {
        return true;
      }
    });
    assert.deepEqual(await poll(surface), { reason: "sentinel", exitCode: 143 });
  });

  it("is a no-op for a child that already ended", async () => {
    const surface = start("scout", "true");
    await poll(surface);
    closeSurface(surface);
    closeSurface(surface);
  });

  it("fails when the socket is up but the pid file is missing", () => {
    const surface = createSurface("scout");
    writeFileSync(surface, "");
    assert.throws(() => closeSurface(surface), /Cannot stop the child .*no usable pid file/);
  });
});

describe("dtach sendCommand", () => {
  it("pushes the text, then Enter, into the session", async () => {
    const surface = start("scout", "sleep 30");
    await until(() => existsSync(surface));
    sendCommand(surface, "hello there");
    const pushes = dtachLog().split("\n").filter((l) => l.startsWith("PUSH:"));
    assert.equal(pushes.length, 2);
    assert.match(pushes[0], /h e l l o/);
    assert.match(pushes[1], /\\r/);
    assert.match(dtachLog(), new RegExp(`-p ${surface}`));
    closeSurface(surface);
  });

  it("fails when the child has ended", () => {
    const surface = createSurface("scout");
    assert.throws(() => sendCommand(surface, "hi"), /is gone; the child has ended/);
  });

  it("fails for a path that is not a child socket", () => {
    assert.throws(() => sendCommand("/tmp/other.sock", "hi"), /Not a dtach surface/);
  });
});

describe("dtach announceSurface", () => {
  it("posts only the id, with the agent key, to the thread's children route", async () => {
    const surface = createSurface("scout");
    const calls: any[] = [];
    globalThis.fetch = (async (url: string, init: any) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await announceSurface(surface);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://api.test:7777/v1/threads/thread-x/children");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.Authorization, "Bearer key-1");
    assert.deepEqual(JSON.parse(calls[0].init.body), { id: childIdFromSurface(surface) });
  });

  it("stops the child and names the status when the API refuses", async () => {
    const surface = start("scout", "sleep 30");
    await until(() => existsSync(surface));
    globalThis.fetch = (async () => new Response("bad id", { status: 400 })) as typeof fetch;
    await assert.rejects(announceSurface(surface), /HTTP 400 bad id.*The child was stopped/s);
    await until(() => !existsSync(surface));
  });

  it("stops the child when the API cannot be reached", async () => {
    const surface = start("scout", "sleep 30");
    await until(() => existsSync(surface));
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    await assert.rejects(announceSurface(surface), /ECONNREFUSED.*The child was stopped/s);
    await until(() => !existsSync(surface));
  });

  it("names the missing variable", async () => {
    delete process.env.SAGA_AGENT_KEY;
    const surface = createSurface("scout");
    globalThis.fetch = (async () => new Response("{}")) as typeof fetch;
    await assert.rejects(announceSurface(surface), /SAGA_AGENT_KEY is not set/);
  });
});

describe("mux backend switch", () => {
  it("chooses by environment, and a forced value wins", () => {
    assert.equal(mux.selectBackend({}), "tmux");
    assert.equal(mux.selectBackend({ SAGA_API_URL: "u" }), "tmux");
    assert.equal(mux.selectBackend({ SAGA_API_URL: "u", SAGA_THREAD: "t" }), "dtach");
    const saga = { SAGA_API_URL: "u", SAGA_THREAD: "t" };
    assert.equal(mux.selectBackend({ PI_SUBAGENT_MUX: "tmux", ...saga }), "tmux");
    assert.equal(mux.selectBackend({ PI_SUBAGENT_MUX: "dtach" }), "dtach");
  });

  it("rejects an unknown forced value", () => {
    assert.throws(
      () => mux.selectBackend({ PI_SUBAGENT_MUX: "screen" }),
      /must be "tmux" or "dtach"/,
    );
  });

  it("routes to dtach in a saga container and to the tmux sentinel otherwise", () => {
    const surface = mux.createSurface("scout");
    assert.match(surface, /sub-scout-[0-9a-f]{6}\.sock$/);
    assert.match(mux.withExitMarker(surface, "pi"), /exit-code/);
    assert.equal(mux.readScreen(surface), "");
    process.env.PI_SUBAGENT_MUX = "tmux";
    assert.equal(mux.withExitMarker("%1", "pi"), "pi; echo '__SUBAGENT_DONE_'$?'__'");
  });

  it("does not announce under tmux", async () => {
    process.env.PI_SUBAGENT_MUX = "tmux";
    globalThis.fetch = (async () => {
      throw new Error("must not be called");
    }) as typeof fetch;
    await mux.announceSurface("%1");
  });
});
