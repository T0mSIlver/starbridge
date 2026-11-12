// Takes the lock of the config folder in argv[2] as another process would, and says so on stdout:
// "waiting" before it asks for the lock, "ran" once it holds it.
import { Store } from "../../src/config";

console.log("waiting");
new Store(process.argv[2] as string).locked(() => console.log("ran"));
