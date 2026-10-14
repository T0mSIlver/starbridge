import { expect, test } from "bun:test";
import { failingTests } from "../scripts/flakes";

test("names the failing tests of bun, Gradle and XCTest logs, else the error lines", () => {
  const log = [
    "2026-10-13T10:00:00.0000000Z (pass) ask > waits [12.00ms]",
    "2026-10-13T10:00:01.0000000Z (fail) ask > settles once [5003.10ms]",
    "2026-10-13T10:00:02.0000000Z OutageNoticeTest > showsNotice FAILED",
    "2026-10-13T10:00:03.0000000Z Test Case '-[StarbridgeTests.SealTests testOpen]' failed (0.01 seconds).",
    "2026-10-13T10:00:04.0000000Z ##[error]Process completed with exit code 1.",
  ].join("\n");
  expect(failingTests(log)).toEqual([
    "ask > settles once",
    "OutageNoticeTest > showsNotice",
    "-[StarbridgeTests.SealTests testOpen]",
  ]);
  expect(
    failingTests(
      "2026-10-13T10:00:00.0Z ##[error]pair failed\n2026-10-13T10:00:00.0Z ##[error]Process completed with exit code 1.",
    ),
  ).toEqual(["pair failed"]);
});
