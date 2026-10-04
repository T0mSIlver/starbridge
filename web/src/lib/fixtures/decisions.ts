import { ago, ahead } from "../now";
import type { InboxItem } from "../types";

const to = ["dev-1", "dev-2"];

export const inbox: InboxItem[] = [
  {
    decision: {
      v: 1,
      id: "d-104",
      to,
      createdAt: ago(4),
      question: "Run speech inference on your Mac while you are away?",
      context:
        "The localvoxtral eval needs the Mac's GPU for about 40 minutes. The CI runner is idle. Yes starts now; Tonight books it for 01:00.",
      options: ["Yes, now", "Tonight at 01:00", "No"],
      recommended: "Yes, now",
      default: { action: "Books it for tonight", at: ahead(25) },
      source: { machine: "devbox", project: "localvoxtral", session: "a3f9c2" },
    },
  },
  {
    decision: {
      v: 1,
      id: "d-103",
      to,
      createdAt: ago(18),
      question: "Merge #42 although the Android lane is still queued?",
      context:
        "The web and server lanes are green. The Android lane waits on the Mac runner and touches no shared file. https://github.com/T0mSIlver/starbridge/pull/42",
      options: ["Merge now", "Wait for the lane"],
      recommended: "Wait for the lane",
      default: { action: "Waits for the lane", at: ahead(90) },
      source: { machine: "devbox", project: "starbridge", session: "orchestrator" },
    },
  },
  {
    decision: {
      v: 1,
      id: "d-102",
      to,
      createdAt: ago(52),
      question: "What should the release notes call the new dictation mode?",
      context:
        "The PR calls it `continuous`; the settings screen says 'hands-free'. Pick one or write another. The string lives here:\n```swift\nstatic let modeName = String(localized: \"continuous\")\n```",
      options: [],
      default: { action: "Keeps 'continuous'", at: ahead(240) },
      source: { machine: "mac", project: "localvoxtral", session: "7be01d" },
    },
  },
  {
    decision: {
      v: 1,
      id: "d-101",
      to,
      createdAt: ago(190),
      question: "Use Hetzner CX23 for the relay?",
      context: "€5.49 a month, Falkenstein. netcup raised prices 40% on 22 September.",
      options: ["CX23", "CAX11 (Arm)"],
      recommended: "CX23",
      default: { action: "Picks CX23", at: ago(10) },
      source: { machine: "devbox", project: "starbridge", session: "c41e88" },
    },
    answer: {
      v: 1,
      id: "a-101",
      decisionId: "d-101",
      to: "m-1",
      answeredAt: ago(170),
      choice: "CX23",
    },
    answeredBy: "Pixel 11 Pro",
  },
  {
    decision: {
      v: 1,
      id: "d-100",
      to,
      createdAt: ago(320),
      question: "Name for the decision skill?",
      context: "It replaces needs-you once the service runs.",
      options: [],
      default: { action: "Keeps 'needs-you'" },
      source: { machine: "devbox", project: "starbridge", session: "orchestrator" },
    },
    answer: {
      v: 1,
      id: "a-100",
      decisionId: "d-100",
      to: "m-1",
      answeredAt: ago(300),
      text: "Keep needs-you, alias starbridge-ask",
    },
    answeredBy: "Firefox on Mac",
  },
];
