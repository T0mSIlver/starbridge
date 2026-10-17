// What setup does with the terminal: the pairing check reads and closes a readline on stdin, then
// the next question asks on the same stdin (#1882).
import { createInterface } from "node:readline";
import { terminalPrompt } from "../../src/setup/sys";

const pairing = createInterface({ input: process.stdin }).on("line", () => {});
await new Promise((resolve) => setTimeout(resolve, 600));
pairing.close();
const a = await terminalPrompt().text("Providers?", "none");
console.log(`answer=${a}`);
