import { expect, test } from "bun:test";
import { billingError } from "../src/agent/billing-error";

test.each([
  ['402 {"error":{"code":"plan_required"}}', "plan_required"],
  ['429 {"error":{"code":"budget_exceeded"}}', "budget_exceeded"],
  ["network disconnected", null],
] as const)("classifies gateway failures without hiding other model errors", (message, code) => {
  expect(billingError(message)?.code ?? null).toBe(code);
});
