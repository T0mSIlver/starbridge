// A question's life on this machine, one module per job under decisions/, re-exported here so
// callers import from one place: source (who asks), build (the decision, its limits and its
// seal), post (`ask`), waiting (`waiting` and `working`), poll (the long-poll, the shared cursor
// and answers held while the directory is behind), trust (answer checks against the directory),
// reseal (new devices), take (handing answers to sessions), wait, snooze, settle, observe
// (`answers --all`, `decisions --open`) and lines (what the CLI prints).
export { ASK_LIMITS, buildDecision, typedBreaks } from "./decisions/build";
export {
  answerInLine,
  answerLine,
  answerPrefix,
  askLines,
  closedError,
  closedHow,
  type Delivery,
  DONE_LINE,
  delivery,
  deliveryLine,
  hooklessLine,
  MOD_SEEN_MS,
  named,
  pastTime,
  staleLine,
} from "./decisions/lines";
export {
  answersAll,
  decisionsOpen,
  type ObservedAnswer,
  type OpenDecision,
  observedAnswers,
  openDecisions,
  sinceTime,
} from "./decisions/observe";
export { poll } from "./decisions/poll";
export { ask, postDecision } from "./decisions/post";
export { RESEAL_MS } from "./decisions/reseal";
export { pickerReason, type SettleOpts, settle } from "./decisions/settle";
export {
  acceptSnooze,
  printSnooze,
  snoozedUntil,
  snoozeLine,
  snoozeTime,
  takeSnooze,
} from "./decisions/snooze";
export {
  ASK_CONTENT_FIELDS,
  ASK_ROUTE_FIELDS,
  type AskContent,
  type AskInput,
  bindSession,
  pickFields,
  resolveSource,
} from "./decisions/source";
export {
  ackLines,
  answers,
  deliverable,
  MAX_CYCLE_SECONDS,
  type SessionLine,
  sessionLines,
  steering,
  takeAnswer,
  takeUnseen,
  waitSeconds,
} from "./decisions/take";
export { behindBy, checkAnswer, dropRevokedNow, noteHead } from "./decisions/trust";
export { EXIT_INTERRUPTED, EXIT_SNOOZED, EXIT_TIMEOUT, wait } from "./decisions/wait";
export { markWaiting, postWaiting, setWaiting } from "./decisions/waiting";
