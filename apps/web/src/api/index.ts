import { FixtureWikiApi } from "./fixture";
import { HttpWikiApi } from "./client";
import type { WikiApi } from "./types";

export * from "./client";
export * from "./query";
export * from "./types";

export function createWikiApi(): WikiApi {
  const environment = (import.meta as unknown as {
    env: { PROD?: unknown; VITE_NAGO_API_BASE_URL?: unknown; VITE_NAGO_API_MODE?: unknown };
  }).env;
  const mode = typeof environment.VITE_NAGO_API_MODE === "string" ? environment.VITE_NAGO_API_MODE : "http";
  if (mode === "fixture") {
    if (environment.PROD === true) throw new Error("Fixture API must never run in production.");
    return new FixtureWikiApi();
  }
  if (mode !== "http") throw new Error(`Unknown VITE_NAGO_API_MODE: ${mode}`);
  const baseUrl = typeof environment.VITE_NAGO_API_BASE_URL === "string" ? environment.VITE_NAGO_API_BASE_URL : "/api/v1";
  return new HttpWikiApi(baseUrl);
}
