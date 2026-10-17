import { expect, test } from "bun:test";
import { join } from "node:path";

const DRIVER = `
import os, pty, select, signal, sys, time
mode, bun, script = sys.argv[1:4]
pid, fd = pty.fork()
if pid == 0:
    os.execvp("sh", ["sh", "-c", f'"{bun}" "{script}" </dev/tty'])
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
if not read_until("Providers?", 20):
    print("NO-PROMPT"); sys.exit(1)
time.sleep(1.5)
os.write(fd, b"\\x03" if mode == "interrupt" else b"hello\\r")
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
print("ANSWERED" if read_until("answer=hello", 5) else "HUNG")
`;

// Bun's own stdin stream stopped answering on a /dev/tty that an earlier readline had closed, and
// Ctrl-C did nothing (#1882). A pty stands in for the terminal under `curl | sh`.
const drive = (mode: "answer" | "interrupt") =>
  Bun.spawnSync(
    [
      "python3",
      "-c",
      DRIVER,
      mode,
      process.execPath,
      join(import.meta.dir, "fixtures/tty-setup-prompt.ts"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

test.skipIf(process.platform === "win32")(
  "a question asked after the pairing check still gets its answer on /dev/tty",
  () => {
    const r = drive("answer");
    expect(r.stdout.toString().trim()).toBe("ANSWERED");
  },
  40_000,
);

test.skipIf(process.platform === "win32")(
  "Ctrl-C ends setup at a question on /dev/tty",
  () => {
    const r = drive("interrupt");
    expect(r.stdout.toString().trim()).toBe("EXITED");
  },
  40_000,
);
