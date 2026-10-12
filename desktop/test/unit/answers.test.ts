import { expect, test } from "bun:test";
import { Answers } from "../../src/answers";

function setup() {
  const notices: { why: string; closed: boolean }[] = [];
  const sent: string[] = [];
  const answers = new Answers(
    (_id, why) => {
      const n = { why, closed: false };
      notices.push(n);
      return {
        close: () => {
          n.closed = true;
        },
      };
    },
    (id) => sent.push(id),
    5,
  );
  return { answers, notices, sent };
}

const late = () => new Promise((r) => setTimeout(r, 20));

test("an answer the page confirms late closes its failure notice and its question's", async () => {
  const { answers, notices, sent } = setup();
  answers.start("d1");
  await late();
  expect(notices).toEqual([{ why: "Starbridge did not answer in time.", closed: false }]);
  answers.settle({ id: "d1" });
  expect(notices[0]?.closed).toBe(true);
  expect(sent).toEqual(["d1"]);
});

test("a late error replaces the time-out notice", async () => {
  const { answers, notices, sent } = setup();
  answers.start("d1");
  await late();
  answers.settle({ id: "d1", error: "The question was already answered." });
  expect(notices).toEqual([
    { why: "Starbridge did not answer in time.", closed: true },
    { why: "The question was already answered.", closed: false },
  ]);
  expect(sent).toEqual([]);
});

test("an answer confirmed in time shows no notice; a word on another is ignored", async () => {
  const { answers, notices, sent } = setup();
  answers.start("d1");
  answers.settle({ id: "d1" });
  answers.settle({ id: "d2" });
  await late();
  expect(notices).toEqual([]);
  expect(sent).toEqual(["d1"]);
});
