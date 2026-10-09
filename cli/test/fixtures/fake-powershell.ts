// Stands in for Windows PowerShell's ScheduledTasks cmdlets: logs each script; the task runs.
// Built into powershell.exe, which setup starts by its path under %SystemRoot%.
import { appendFileSync, copyFileSync } from "node:fs";

const script = process.argv.at(-1) ?? "";
appendFileSync(process.env.FAKE_LOG as string, `powershell ${script}\n`);
if (script.endsWith(").State")) console.log("Running");
if (script.startsWith("Register-"))
  copyFileSync(process.env.STARBRIDGE_TASK_XML as string, `${process.env.FAKE_STATE}.task.xml`);
