// Feedback to the Orbit team and builds a farm shared for review. Orion relays both to Core;
// a shared build reaches other farms only after the Orbit team approves it.
import { type Static, Type } from "typebox";

export const FEEDBACK_KINDS = ["issue", "idea", "other"] as const;
export const FeedbackKind = Type.Enum([...FEEDBACK_KINDS]);
export type FeedbackKind = Static<typeof FeedbackKind>;

export const SHARED_BUILD_KINDS = ["page", "connector", "skill"] as const;
export const SharedBuildKind = Type.Enum([...SHARED_BUILD_KINDS]);
export type SharedBuildKind = Static<typeof SharedBuildKind>;

export const SharedBuild = Type.Object({
  id: Type.String(),
  kind: SharedBuildKind,
  name: Type.String(),
  title: Type.String(),
  status: Type.Enum(["pending", "approved", "rejected"]),
  /** What the Orbit team wrote back, if anything. */
  reviewNote: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});
export type SharedBuild = Static<typeof SharedBuild>;

export const FeedbackRequests = {
  /** Works signed out too; contactEmail is only for people who want an answer and have no account. */
  "feedback.send": {
    params: Type.Object({
      kind: FeedbackKind,
      message: Type.String({ minLength: 1, maxLength: 5000 }),
      contactEmail: Type.Optional(Type.String({ maxLength: 200 })),
      locale: Type.Optional(Type.String({ maxLength: 20 })),
    }),
    result: Type.Object({ id: Type.String() }),
  },
  /** What this account has shared and where each stands in review; needs a signed-in account. */
  "shared.list": {
    params: Type.Object({}),
    result: Type.Object({ submissions: Type.Array(SharedBuild) }),
  },
} as const;
