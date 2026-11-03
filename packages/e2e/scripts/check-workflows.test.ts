import { expect, test } from "bun:test";
import { checkWorkflow } from "./check-workflows";

test("accepts a minimal workflow", () => {
  expect(
    checkWorkflow("on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: []\n"),
  ).toEqual([]);
});

test("reports a job without runs-on and a duplicate key", () => {
  expect(checkWorkflow("on: push\njobs:\n  a:\n    steps: []\n")).toEqual([
    "job a: missing runs-on",
  ]);
  expect(() => checkWorkflow("on: push\non: pull_request\njobs: {}\n")).toThrow();
});
