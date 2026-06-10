/**
 * Integration tests against the REAL @xterm/xterm Terminal (no fakes, no DOM,
 * never open()ed), driving the FULL remote-block pipeline exactly as
 * useTerminalSession wires it: registerPromptTracker + parseSshTarget ssh
 * detection + createRemoteBlockTracker gated on
 * `!!sshHost && !prompt.sawNestedCommand()`.
 *
 * Diagnostic output is printed via console.log so the run transcript carries
 * the real buffer strings / cursor positions / marker lines.
 */
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { commandFromPromptRow } from "./historyMatch";
import {
  createShellIntegrationState,
  registerPromptTracker,
  type CommandBlock,
} from "./osc-handlers";
import { createRemoteBlockTracker } from "./remoteBlocks";
import { parseSshTarget } from "./remoteCwd";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const osc133 = (payload: string) => `${ESC}]133;${payload}${BEL}`;

const SETTLE_WAIT_MS = 250; // > REMOTE_SETTLE_MS (150)
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type EnterProbe = {
  baseY: number;
  cursorY: number;
  cursorX: number;
  rowText: string;
  derivedCommand: string | null;
  markersCreatedDuringEnter: number;
};

function setup() {
  const term = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });

  // Count marker registrations so we can tell, at the exact synchronous
  // input("\r") dispatch, whether the tracker opened a pending block (it
  // registers promptMarker + startMarker = exactly 2 markers; nothing else
  // parses during input()).
  let markerCount = 0;
  const origRegisterMarker = term.registerMarker.bind(term);
  term.registerMarker = ((offset?: number) => {
    markerCount++;
    return origRegisterMarker(offset);
  }) as typeof term.registerMarker;

  let cursorMoves = 0;
  term.onCursorMove(() => cursorMoves++);

  // === wiring mirrors useTerminalSession registerOsc (fresh bind, no spill) ===
  let sshHost: string | null = null;
  const shellState = createShellIntegrationState();
  const prompt = registerPromptTracker(term, shellState, {
    onCommand: (cmd) => {
      sshHost = parseSshTarget(cmd);
    },
    onCommandEnd: () => {
      sshHost = null;
    },
    initialDepth: 0,
  });

  // Spy on pushClosed without changing behavior.
  const pushedClosed: CommandBlock[] = [];
  const origPushClosed = prompt.blocks.pushClosed.bind(prompt.blocks);
  prompt.blocks.pushClosed = (b: CommandBlock) => {
    pushedClosed.push(b);
    origPushClosed(b);
  };

  const tracker = createRemoteBlockTracker(term, prompt.blocks, {
    isActive: () => !!sshHost && !prompt.sawNestedCommand(),
  });

  const write = (data: string) =>
    new Promise<void>((resolve) => term.write(data, resolve));

  /** input("\r") with a synchronous buffer probe taken inside the same onData
   * dispatch (registered after the tracker's handler — same buffer state,
   * nothing parses in between). */
  const pressEnter = (): EnterProbe => {
    let probe: EnterProbe | null = null;
    const d = term.onData((data) => {
      if (data !== "\r") return;
      const buf = term.buffer.active;
      const rowText =
        buf.getLine(buf.baseY + buf.cursorY)?.translateToString(false) ?? "";
      probe = {
        baseY: buf.baseY,
        cursorY: buf.cursorY,
        cursorX: buf.cursorX,
        rowText,
        derivedCommand: commandFromPromptRow(rowText, buf.cursorX),
        markersCreatedDuringEnter: 0,
      };
    });
    const before = markerCount;
    term.input("\r", true);
    d.dispose();
    probe!.markersCreatedDuringEnter = markerCount - before;
    return probe!;
  };

  const summarizeRing = () =>
    prompt.blocks.all().map((b) => ({
      command: b.command,
      source: b.source ?? "local",
      exitCode: b.exitCode,
      promptLine: b.promptMarker?.isDisposed === false ? b.promptMarker.line : null,
      startLine: b.startMarker?.isDisposed === false ? b.startMarker.line : null,
      endLine: b.endMarker?.isDisposed === false ? b.endMarker.line : null,
    }));

  return {
    term,
    write,
    pressEnter,
    prompt,
    tracker,
    pushedClosed,
    summarizeRing,
    getSshHost: () => sshHost,
    getCursorMoves: () => cursorMoves,
  };
}

/** Steps 1–5 of the transcript: local prompt, type+run `ssh pi@host`. */
async function enterSsh(s: ReturnType<typeof setup>) {
  await s.write(osc133("A") + "user@mac ~ % " + osc133("B"));
  s.term.input("ssh pi@host", true);
  await s.write("ssh pi@host"); // local echo
  s.term.input("\r", true);
  await s.write("\r\n");
  await s.write(osc133("C;ssh pi@host")); // local preexec
  expect(s.getSshHost()).toBe("pi@host");
}

describe("remote heuristic blocks — REAL xterm integration", () => {
  it("happy path: fast echo, default bash-ish remote prompt", async () => {
    const s = setup();
    await enterSsh(s);

    // banner + stock remote prompt
    await s.write("Last login: Tue Jun 10 10:00:00 2026 from 10.0.0.2\r\n");
    await s.write("pi@host:~ $ ");
    const movesBeforeTyping = s.getCursorMoves();

    // remote echo of typed command (fast link: echo parsed before Enter)
    s.term.input("ls", true);
    await s.write("ls");

    const probe = s.pressEnter();
    console.log("[happy] enter probe:", JSON.stringify(probe));
    console.log(
      "[happy] cursorMoves total at Enter:",
      s.getCursorMoves(),
      "(during banner+prompt writes:",
      movesBeforeTyping,
      ")",
    );

    expect(probe.rowText.trimEnd()).toBe("pi@host:~ $ ls");
    expect(probe.derivedCommand).toBe("ls");
    // pending opened => tracker registered promptMarker + startMarker
    expect(probe.markersCreatedDuringEnter).toBe(2);

    // remote output + next prompt
    await s.write("\r\nfile1  file2\r\n");
    await s.write("pi@host:~ $ ");
    await sleep(SETTLE_WAIT_MS); // settle (150ms debounce) closes the block

    const ring = s.summarizeRing();
    console.log("[happy] pushClosed calls:", s.pushedClosed.length);
    console.log("[happy] ring:", JSON.stringify(ring, null, 2));
    console.log("[happy] cursorMoves final:", s.getCursorMoves());

    // Force-pushed open local ssh block first, then the heuristic remote block.
    expect(ring.length).toBe(2);
    expect(ring[0]).toMatchObject({
      command: "ssh pi@host",
      source: "local",
    });
    expect(ring[1]).toMatchObject({
      command: "ls",
      source: "remote",
      exitCode: null,
    });
    expect(s.pushedClosed.length).toBe(1);
    s.tracker.dispose();
    s.prompt.dispose();
  });

  it("V1 laggy echo: Enter dispatched before the remote echoed anything", async () => {
    const s = setup();
    await enterSsh(s);
    await s.write("Last login: ...\r\npi@host:~ $ ");

    // Laggy link: keystrokes go out, NO echo parsed yet.
    s.term.input("ls", true);
    const probe = s.pressEnter();
    console.log("[V1 laggy] enter probe:", JSON.stringify(probe));

    // Echo + output + prompt all arrive afterwards.
    await s.write("ls\r\nfile1  file2\r\npi@host:~ $ ");
    await sleep(SETTLE_WAIT_MS);

    const ring = s.summarizeRing();
    console.log("[V1 laggy] ring:", JSON.stringify(ring, null, 2));
    console.log("[V1 laggy] pushClosed calls:", s.pushedClosed.length);

    // Report-only: what (if anything) was captured.
    // Expected from code reading: rowText has no typed input at Enter =>
    // commandFromPromptRow null => no pending => zero remote blocks.
    expect(probe.derivedCommand).toBeNull();
    expect(probe.markersCreatedDuringEnter).toBe(0);
    expect(ring.filter((b) => b.source === "remote").length).toBe(0);
    s.tracker.dispose();
    s.prompt.dispose();
  });

  it("V2 root prompt `root@vps:~# `", async () => {
    const s = setup();
    await enterSsh(s);
    await s.write("Welcome\r\nroot@vps:~# ");
    s.term.input("whoami", true);
    await s.write("whoami");
    const probe = s.pressEnter();
    console.log("[V2 root] enter probe:", JSON.stringify(probe));
    await s.write("\r\nroot\r\nroot@vps:~# ");
    await sleep(SETTLE_WAIT_MS);
    const ring = s.summarizeRing();
    console.log("[V2 root] ring:", JSON.stringify(ring, null, 2));

    expect(probe.derivedCommand).toBe("whoami");
    expect(ring[ring.length - 1]).toMatchObject({
      command: "whoami",
      source: "remote",
      exitCode: null,
    });
    s.tracker.dispose();
    s.prompt.dispose();
  });

  it("V3 oh-my-zsh prompt `➜  ~ ` (documented limitation: no sigil)", async () => {
    const s = setup();
    await enterSsh(s);
    await s.write("Welcome\r\n➜  ~ ");
    s.term.input("ls", true);
    await s.write("ls");
    const probe = s.pressEnter();
    console.log("[V3 omz] enter probe:", JSON.stringify(probe));
    await s.write("\r\nfile1\r\n➜  ~ ");
    await sleep(SETTLE_WAIT_MS);
    const ring = s.summarizeRing();
    console.log("[V3 omz] ring:", JSON.stringify(ring, null, 2));

    expect(probe.derivedCommand).toBeNull();
    expect(ring.filter((b) => b.source === "remote").length).toBe(0);
    s.tracker.dispose();
    s.prompt.dispose();
  });

  it("V4a prompt sigil with NO trailing space `pi@host:~ %`", async () => {
    const s = setup();
    await enterSsh(s);
    await s.write("Welcome\r\npi@host:~ %");
    s.term.input("ls", true);
    await s.write("ls");
    const probe = s.pressEnter();
    console.log("[V4a no-space] enter probe:", JSON.stringify(probe));
    await s.write("\r\nfile1\r\npi@host:~ %");
    await sleep(SETTLE_WAIT_MS);
    const ring = s.summarizeRing();
    console.log("[V4a no-space] ring:", JSON.stringify(ring, null, 2));

    // `%l` is not sigil+space, so no boundary => no capture.
    expect(probe.derivedCommand).toBeNull();
    expect(ring.filter((b) => b.source === "remote").length).toBe(0);
    s.tracker.dispose();
    s.prompt.dispose();
  });

  it("stacked local integrations (iTerm2 + termul): duplicate C/D collapsed, heuristic stays armed", async () => {
    // The user's ~/.zshrc sourcing iTerm2's shell integration on top of
    // Termul's makes every local command emit TWO C's (iTerm2's `C;` then
    // termul's `C;<cmd>`, same row) and TWO D's. Without dedup the second C
    // reads as a nested remote integration and the heuristic stands down for
    // the entire ssh session — the exact "zero blocks inside ssh" bug.
    const s = setup();
    await s.write(osc133("A") + osc133("A") + "user@mac ~ % " + osc133("B") + osc133("B"));
    s.term.input("ssh pi@host", true);
    await s.write("ssh pi@host");
    s.term.input("\r", true);
    await s.write("\r\n");
    await s.write(osc133("C;")); // iTerm2's preexec (empty payload)
    await s.write(osc133("C;ssh pi@host")); // termul's preexec — SAME row
    expect(s.getSshHost()).toBe("pi@host");
    expect(s.prompt.sawNestedCommand()).toBe(false); // the latch must NOT flip

    await s.write("Last login: ...\r\npi@host:~ $ ");
    s.term.input("ls", true);
    await s.write("ls");
    const probe = s.pressEnter();
    console.log("[stacked] enter probe:", JSON.stringify(probe));
    expect(probe.derivedCommand).toBe("ls");
    expect(probe.markersCreatedDuringEnter).toBe(2); // pending OPENED

    await s.write("\r\nfile1  file2\r\npi@host:~ $ ");
    await sleep(SETTLE_WAIT_MS);

    const ring = s.summarizeRing();
    console.log("[stacked] ring:", JSON.stringify(ring, null, 2));
    expect(ring[ring.length - 1]).toMatchObject({
      command: "ls",
      source: "remote",
      exitCode: null,
    });

    // ssh exits: both integrations emit D on the same row — end fires once and
    // the pill clears. The FIRST D finds no open block (pushClosed flushed it)
    // and degrades to one invisible empty entry — the documented local-D
    // pairing cost. The dedup's job is that the duplicate D adds no SECOND one.
    s.term.input("exit", true);
    await s.write("exit\r\nlogout\r\nConnection to pi@host closed.\r\n");
    await s.write(osc133("D;0") + osc133("D;0"));
    expect(s.getSshHost()).toBeNull();
    const after = s.summarizeRing();
    expect(after.filter((b) => b.command === "" && b.startLine === null).length).toBe(1);
    s.tracker.dispose();
    s.prompt.dispose();
  });

  it("stacked local integrations: a plain local command yields ONE closed block", async () => {
    const s = setup();
    await s.write(osc133("A") + osc133("A") + "user@mac ~ % " + osc133("B") + osc133("B"));
    s.term.input("echo hi", true);
    await s.write("echo hi");
    s.term.input("\r", true);
    await s.write("\r\n");
    await s.write(osc133("C;") + osc133("C;echo hi")); // stacked pair, same row
    await s.write("hi\r\n");
    await s.write(osc133("D;0") + osc133("D;0")); // stacked pair, same row
    await s.write(osc133("A") + osc133("A") + "user@mac ~ % " + osc133("B") + osc133("B"));

    const ring = s.summarizeRing();
    console.log("[stacked local] ring:", JSON.stringify(ring, null, 2));
    expect(ring).toHaveLength(1); // not two half-blocks + a degraded empty
    expect(ring[0]).toMatchObject({ command: "echo hi", exitCode: 0, source: "local" });
    s.tracker.dispose();
    s.prompt.dispose();
  });

  it("V4b two-line remote prompt (command row is `$ `)", async () => {
    const s = setup();
    await enterSsh(s);
    await s.write("Welcome\r\nuser@host ~/projects\r\n$ ");
    s.term.input("ls", true);
    await s.write("ls");
    const probe = s.pressEnter();
    console.log("[V4b two-line] enter probe:", JSON.stringify(probe));
    await s.write("\r\nfile1\r\nuser@host ~/projects\r\n$ ");
    await sleep(SETTLE_WAIT_MS);
    const ring = s.summarizeRing();
    console.log("[V4b two-line] ring:", JSON.stringify(ring, null, 2));

    expect(probe.derivedCommand).toBe("ls");
    expect(ring[ring.length - 1]).toMatchObject({
      command: "ls",
      source: "remote",
      exitCode: null,
    });
    s.tracker.dispose();
    s.prompt.dispose();
  });
});
