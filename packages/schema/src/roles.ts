// Farm roles and what each may do. Shared by Core (cloud enforcement) and Orion (the same rule
// applied locally while signed in), so the two can never disagree.
import type { SyncedTable } from "./enums";

export const FARM_ROLES = ["owner", "manager", "worker", "viewer"] as const;
export type FarmRole = (typeof FARM_ROLES)[number];

export function isFarmRole(value: unknown): value is FarmRole {
  return typeof value === "string" && (FARM_ROLES as readonly string[]).includes(value);
}

/**
 * Synced tables each role may change. Workers keep the herd, sensors and observations up to date;
 * farm settings, connectors and cameras (which carry integration and credential references) are
 * for owners and managers. Viewers only read.
 */
const WRITABLE: Record<FarmRole, readonly SyncedTable[] | "all"> = {
  owner: "all",
  manager: "all",
  worker: ["animals", "devices", "device_bindings", "observations"],
  viewer: [],
};

export function canWriteTable(role: FarmRole, table: SyncedTable): boolean {
  const allowed = WRITABLE[role];
  return allowed === "all" || allowed.includes(table);
}

export function canManageMembers(role: FarmRole): boolean {
  return role === "owner" || role === "manager";
}

/** Roles `actor` may hand out (invite to, or change a member to). Only an owner makes owners. */
export function assignableRoles(actor: FarmRole): readonly FarmRole[] {
  if (actor === "owner") return FARM_ROLES;
  if (actor === "manager") return ["manager", "worker", "viewer"];
  return [];
}

export function canManageMember(actor: FarmRole, target: FarmRole): boolean {
  if (!canManageMembers(actor)) return false;
  return actor === "owner" || target !== "owner";
}
