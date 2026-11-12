import { beforeEach, expect } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createSession } from "../src/auth";
import { farmMembers, farmSubscriptions, users } from "../src/db";
import { object } from "../src/stripe";
import { billingFixture, FARM, NOW } from "./billing-fixture";

export function multiUserFixture() {
  const { app, db, headers, session } = billingFixture();
  const person = { id: "", token: "" };
  const gateway = () =>
    app({
      fetch: async () => Response.json({ usage: { prompt_tokens: 3, completion_tokens: 4 } }),
    });
  const memberHeaders = (farm = true) => ({
    authorization: `Bearer ${person.token}`,
    "content-type": "application/json",
    ...(farm ? { "x-orbit-farm": FARM } : {}),
  });
  beforeEach(async () => {
    await db.insert(farmSubscriptions).values({ farmId: FARM, plan: "orion", status: "active" });
    const [user] = await db
      .insert(users)
      .values({
        email: "member@example.test",
        createdAt: NOW.toISOString(),
        emailVerifiedAt: NOW.toISOString(),
      })
      .returning();
    if (!user) throw new TypeError("Member fixture failed");
    person.id = user.id;
    person.token = (await createSession(db, user.id, null, NOW)).token;
  });

  async function join(useFarmPlan = false) {
    const a = gateway();
    const invitation = await a.request(`/v1/farms/${FARM}/invites`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        email: "member@example.test",
        role: "worker",
        useFarmPlan,
      }),
    });
    const invite = object(await invitation.json());
    expect(invitation.status).toBe(201);
    expect(object(invite.invite).useFarmPlan).toBe(useFarmPlan);
    const accepted = await a.request("/v1/invites/accept", {
      method: "POST",
      headers: memberHeaders(),
      body: JSON.stringify({ code: invite.code }),
    });
    expect(accepted.status).toBe(200);
    return a;
  }
  const llm = (a = gateway(), farm = true) =>
    a.request("/v1/llm/v1/chat/completions", {
      method: "POST",
      headers: memberHeaders(farm),
      body: "{}",
    });
  const memberKey = () => and(eq(farmMembers.farmId, FARM), eq(farmMembers.userId, person.id));

  return { app, db, headers, session, person, gateway, memberHeaders, join, llm, memberKey };
}
