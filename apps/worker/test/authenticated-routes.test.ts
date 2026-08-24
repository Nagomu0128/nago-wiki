import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { createAiRoutes } from "../src/ai/routes";
import { createBotRoutes } from "../src/bots/routes";

describe("authenticated route boundaries", () => {
  it("does not accept a caller-supplied user header for search", async () => {
    const response = await createAiRoutes().request(
      "https://wiki.example/search",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-nago-user-id": "00000000-0000-7000-8000-000000000099",
        },
        body: JSON.stringify({ query: "secret", mode: "hybrid" }),
      },
      env,
    );

    expect(response.status).toBe(401);
  });

  it("does not accept a caller-supplied user header for account links", async () => {
    const response = await createBotRoutes().request(
      "https://wiki.example/account-links",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-nago-user-id": "00000000-0000-7000-8000-000000000099",
        },
        body: JSON.stringify({ provider: "line" }),
      },
      env,
    );

    expect(response.status).toBe(401);
  });
});
