import type { AuthenticatedIdentity } from "@nago-wiki/shared";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  createAccessAuthenticationMiddleware,
  type AccessAuthenticationConfig,
  type AccessIdentityRepository,
} from "../src/auth/access";
import type {
  AccessJwtClaims,
  AccessJwtVerifier,
} from "../src/auth/jwt";
import {
  coreErrorHandler,
  coreRequestContext,
  type CoreHonoEnv,
} from "../src/core/context";

const config: AccessAuthenticationConfig = {
  audience: "access-audience",
  issuer: "https://team.cloudflareaccess.com",
  environment: "production",
};
const identity: AuthenticatedIdentity = {
  id: "00000000-0000-7000-8000-000000000010",
  workspaceId: "00000000-0000-7000-8000-000000000001",
  email: "viewer@example.com",
  displayName: "Viewer",
  role: "viewer",
  status: "active",
  subject: "access-subject",
  expiresAt: 2_000_000_000,
};

class FakeIdentityRepository implements AccessIdentityRepository {
  public claims: AccessJwtClaims | undefined;
  public bootstrapOwnerEmail: string | undefined;

  public resolveAccessIdentity(
    claims: AccessJwtClaims,
    _workspaceId?: string,
    bootstrapOwnerEmail?: string,
  ): Promise<AuthenticatedIdentity> {
    this.claims = claims;
    this.bootstrapOwnerEmail = bootstrapOwnerEmail;
    return Promise.resolve({ ...identity, subject: claims.sub, email: claims.email });
  }
}

describe("Access authentication middleware", () => {
  it("does not enable development identity fallback implicitly", async () => {
    const response = await authApp(
      config,
      new FakeIdentityRepository(),
    ).request("https://wiki.example/private", undefined, env);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "AUTHENTICATION_REQUIRED" },
    });
  });

  it("allows explicitly gated development identity headers only in development", async () => {
    const repository = new FakeIdentityRepository();
    const response = await authApp(
      {
        ...config,
        environment: "development",
        allowDevelopmentIdentity: true,
      },
      repository,
    ).request(
      "https://wiki.example/private",
      {
        headers: {
          "X-Development-User-Email": "developer@example.com",
          "X-Development-User-Subject": "local-user",
        },
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(repository.claims).toMatchObject({
      email: "developer@example.com",
      sub: "local-user",
    });
  });

  it("uses the verified assertion claims instead of development headers", async () => {
    const repository = new FakeIdentityRepository();
    const verifier: AccessJwtVerifier = {
      verify: () =>
        Promise.resolve({
          aud: config.audience,
          email: "verified@example.com",
          exp: 2_000_000_000,
          iss: config.issuer,
          sub: "verified-subject",
        }),
    };
    const response = await authApp(config, repository, verifier).request(
      "https://wiki.example/private",
      { headers: { "Cf-Access-Jwt-Assertion": "signed.jwt.value" } },
      env,
    );

    expect(response.status).toBe(200);
    expect(repository.claims?.sub).toBe("verified-subject");
  });

  it("passes the configured bootstrap owner address only to the repository", async () => {
    const repository = new FakeIdentityRepository();
    const verifier: AccessJwtVerifier = {
      verify: () =>
        Promise.resolve({
          aud: config.audience,
          email: "verified@example.com",
          exp: 2_000_000_000,
          iss: config.issuer,
          sub: "verified-subject",
        }),
    };
    const response = await authApp(
      { ...config, bootstrapOwnerEmail: "owner@example.com" },
      repository,
      verifier,
    ).request(
      "https://wiki.example/private",
      { headers: { "Cf-Access-Jwt-Assertion": "signed.jwt.value" } },
      env,
    );

    expect(response.status).toBe(200);
    expect(repository.bootstrapOwnerEmail).toBe("owner@example.com");
  });
});

function authApp(
  resolvedConfig: AccessAuthenticationConfig,
  repository: AccessIdentityRepository,
  verifier?: AccessJwtVerifier,
): Hono<CoreHonoEnv> {
  const app = new Hono<CoreHonoEnv>();
  app.onError(coreErrorHandler);
  app.use("*", coreRequestContext);
  app.use(
    "*",
    createAccessAuthenticationMiddleware({
      resolveConfig: () => resolvedConfig,
      createRepository: () => repository,
      ...(verifier === undefined ? {} : { createVerifier: () => verifier }),
    }),
  );
  app.get("/private", (context) =>
    context.json({ userId: context.get("identity")?.id }),
  );
  return app;
}
