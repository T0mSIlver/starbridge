import { expect, test } from "bun:test";
import { join } from "node:path";

const DRIVER = `
import os, pty, select, signal, sys, time
mode, bun, script, prompt, extra = sys.argv[1:6]
pid, fd = pty.fork()
if pid == 0:
    os.execvp("sh", ["sh", "-c", f'"{bun}" "{script}" {extra} </dev/tty'])
buf = b""
def read_until(text, secs):
    global buf
    end = time.time() + secs
    while text.encode() not in buf and time.time() < end:
        if select.select([fd], [], [], 0.2)[0]:
            try:
                data = os.read(fd, 4096)
            except OSError:
                return False
            if not data:
                return False
            buf += data
    return text.encode() in buf
if not read_until(prompt, 20):
    print("NO-PROMPT " + repr(buf)); sys.exit(1)
time.sleep(1.5)
if mode == "edit":
    # Left arrow, then a letter typed in the middle of the answer.
    os.write(fd, b"abc\\x1b[DX\\r")
elif mode == "interrupt":
    os.write(fd, b"\\x03")
elif mode == "answer":
    os.write(fd, b"hello\\r")
elif mode == "confirm":
    os.write(fd, b"y\\r")
    if not read_until("check=yes", 5):
        print("HUNG " + repr(buf)); sys.exit(1)
if mode == "interrupt":
    # The terminal reports end of file once every process on it has gone.
    end = time.time() + 5
    while time.time() < end:
        if select.select([fd], [], [], 0.2)[0]:
            try:
                if not os.read(fd, 4096):
                    print("EXITED"); sys.exit(0)
            except OSError:
                print("EXITED"); sys.exit(0)
    os.kill(pid, signal.SIGKILL)
    print("HUNG"); sys.exit(1)
if mode in ("confirm", "elsewhere"):
    # The next setup question still reads the terminal.
    if not read_until("Providers?", 5):
        print("HUNG " + repr(buf)); sys.exit(1)
    time.sleep(0.5)
    os.write(fd, b"hello\\r")
ok = read_until("answer=" + ("abXc" if mode == "edit" else "hello"), 5); print("ANSWERED" if ok else "HUNG " + repr(buf))
`;

type Mode = "answer" | "edit" | "interrupt" | "confirm" | "elsewhere";

// Bun's own stdin stream stopped answering on a /dev/tty that an earlier readline had closed, and
// Ctrl-C did nothing (#1882); the pairing check read it the same way (#2036). A pty stands in for
// the terminal under `curl | sh`.
const drive = (mode: Mode, fixture: "setup" | "pair" = "setup") =>
  Bun.spawnSync(
    [
      "python3",
      "-c",
      DRIVER,
      mode,
      process.execPath,
      join(
        import.meta.dir,
        `fixtures/tty-${fixture === "setup" ? "setup-prompt" : "pair-confirm"}.ts`,
      ),
      fixture === "setup" ? "Providers?" : "Same code?",
      mode === "elsewhere" ? "elsewhere" : "",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

const unix = test.skipIf(process.platform === "win32");

unix(
  "a question asked after the pairing check still gets its answer on /dev/tty",
  () => {
    expect(drive("answer").stdout.toString().trim()).toBe("ANSWERED");
  },
  40_000,
);

unix(
  "the arrow keys still edit an answer on /dev/tty",
  () => {
    expect(drive("edit").stdout.toString().trim()).toBe("ANSWERED");
  },
  40_000,
);

unix(
  "Ctrl-C ends setup at a question on /dev/tty",
  () => {
    expect(drive("interrupt").stdout.toString().trim()).toBe("EXITED");
  },
  40_000,
);

unix(
  "the pairing check takes y typed on /dev/tty, and the next question still reads it",
  () => {
    expect(drive("confirm", "pair").stdout.toString().trim()).toBe("ANSWERED");
  },
  40_000,
);

unix(
  "Ctrl-C ends pairing at the check code on /dev/tty",
  () => {
    expect(drive("interrupt", "pair").stdout.toString().trim()).toBe("EXITED");
  },
  40_000,
);

unix(
  "a check confirmed from another terminal leaves /dev/tty readable for the next question",
  () => {
    expect(drive("elsewhere", "pair").stdout.toString().trim()).toBe("ANSWERED");
  },
  40_000,
);
