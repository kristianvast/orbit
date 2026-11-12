import { BillingPlans, BillingStatus, type RequestParams } from "@orbit/protocol";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { AccountError, type AccountService } from "./account";

const UrlResult = Type.Object({ url: Type.String() });
const CloudError = Type.Object({
  error: Type.Object({ code: Type.Optional(Type.String()), message: Type.Optional(Type.String()) }),
});

/** Core remains the authority for prices, roles, entitlement and usage. */
export class BillingService {
  constructor(
    private readonly account: Pick<AccountService, "cloudConnection">,
    private readonly doFetch: (
      input: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response> = fetch,
  ) {}

  async status(): Promise<BillingStatus> {
    const result = await this.call("status");
    if (!Value.Check(BillingStatus, result)) {
      throw new AccountError("not_ready", "Orbit cloud returned an invalid billing status.");
    }
    return result;
  }

  async plans(): Promise<BillingPlans> {
    const result = await this.call("plans");
    if (!Value.Check(BillingPlans, result)) {
      throw new AccountError("not_ready", "Orbit cloud returned an invalid billing catalogue.");
    }
    return result;
  }

  async checkout(params: RequestParams<"billing.checkout">): Promise<{ url: string }> {
    return this.link("checkout", params);
  }

  async portal(params: RequestParams<"billing.portal"> = {}): Promise<{ url: string }> {
    return this.link("portal", params);
  }

  private async link(path: "checkout" | "portal", body: unknown): Promise<{ url: string }> {
    const result = await this.call(path, body);
    if (
      !Value.Check(UrlResult, result) ||
      !URL.canParse(result.url) ||
      new URL(result.url).protocol !== "https:"
    ) {
      throw new AccountError("not_ready", "Orbit cloud returned an invalid billing link.");
    }
    return result;
  }

  private async call(path: string, body?: unknown): Promise<unknown> {
    const { url, headers } = this.account.cloudConnection();
    let response: Response;
    try {
      response = await this.doFetch(`${url}/v1/billing/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...headers,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new AccountError("not_ready", `Orbit cloud is unreachable: ${error.message}`);
    }
    const result: unknown = await response.json();
    if (response.ok) return result;
    const message = Value.Check(CloudError, result) ? result.error.message : undefined;
    switch (response.status) {
      case 401:
        throw new AccountError("unauthorized", message ?? "Sign in to manage your plan.");
      case 403:
        throw new AccountError(
          "forbidden",
          message ?? "Only farm owners and managers can manage billing.",
        );
      case 402:
        throw new AccountError(
          "plan_required",
          "Choose a plan or use your own AI key in Providers.",
        );
      case 429:
        throw new AccountError(
          "budget_exceeded",
          "Your Orion allowance is used up for this period.",
        );
      default:
        throw new AccountError("not_ready", message ?? `Orbit cloud answered ${response.status}.`);
    }
  }
}
