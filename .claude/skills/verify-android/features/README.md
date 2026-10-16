# Android features

| Feature | File | Driven by | CI |
|---|---|---|---|
| Sign-in and join | [sign-in-join.md](sign-in-join.md) | `signInAndJoin` | every emulator run |
| A question's notification | [notification.md](notification.md) | `android.ts` | every emulator run |
| The card and answering | [card-answer.md](card-answer.md) | `android.ts`, `ANSWER` | the card yes, answering no |
| The launcher icon | [launcher-icon.md](launcher-icon.md) | `EVIDENCE`, `evidence.ts` | every emulator run |

No feature file yet: snooze, quotas, settings, widgets, UnifiedPush and the
recovery key. Their JVM tests are in `android/app/src/test` and their reference
screens in `android/app/screenshots/`; to drive them on the emulator, use the
same tools.
