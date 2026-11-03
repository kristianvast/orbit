// Shared constants for the Orbit end-to-end suites.

/** Orion port used by the web suite; 7717 stays free for `bun run dev`. */
export const E2E_ORION_PORT = Number(process.env.ORBIT_E2E_ORION_PORT ?? 7718);
/** Vite port used by the web suite; 5173 stays free for the normal dev server. */
export const E2E_VITE_PORT = Number(process.env.ORBIT_E2E_VITE_PORT ?? 5183);
export const E2E_TOKEN = "e2e";

/** Seeded demo farm (packages/schema/src/seed.ts). */
export const SEED = {
  cattle: 24,
  horses: 4,
  firstDairyEarTag: "DK-1001",
  firstDairyName: "Bella",
} as const;
