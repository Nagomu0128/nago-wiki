import type { AuthenticatedIdentity } from "@nago-wiki/shared";
import { createMiddleware } from "hono/factory";
import type { CoreHonoEnv } from "../core/context";
import { ApiProblem } from "../core/errors";
import {
  DEFAULT_WORKSPACE_ID,
  D1WikiRepository,
} from "../core/repository";
import {
  CloudflareAccessJwtVerifier,
  type AccessJwtClaims,
  type AccessJwtVerifier,
} from "./jwt";

const ACCESS_ASSERTION_HEADER = "Cf-Access-Jwt-Assertion";

export interface AccessAuthenticationConfig {
  audience: string;
  issuer: string;
  jwksUrl?: string;
  workspaceId?: string;
  bootstrapOwnerEmail?: string;
  environment: string;
  allowDevelopmentIdentity?: boolean;
}

export interface AccessAuthenticationOptions {
  resolveConfig: (environment: Env) => AccessAuthenticationConfig;
  createRepository?: (database: D1Database) => AccessIdentityRepository;
  createVerifier?: (config: AccessAuthenticationConfig) => AccessJwtVerifier;
}

export interface AccessIdentityRepository {
  resolveAccessIdentity(
    claims: AccessJwtClaims,
    workspaceId?: string,
    bootstrapOwnerEmail?: string,
  ): Promise<AuthenticatedIdentity>;
}

export function createAccessAuthenticationMiddleware(
  options: AccessAuthenticationOptions,
) {
  return createMiddleware<CoreHonoEnv>(async (context, next) => {
    const config = options.resolveConfig(context.env);
    const repository =
      options.createRepository?.(context.env.DB) ??
      new D1WikiRepository(context.env.DB);
    const assertion = context.req.header(ACCESS_ASSERTION_HEADER);
    let claims: AccessJwtClaims;

    if (assertion !== undefined) {
      const verifier =
        options.createVerifier?.(config) ??
        new CloudflareAccessJwtVerifier({
          audience: config.audience,
          issuer: config.issuer,
          ...(config.jwksUrl === undefined ? {} : { jwksUrl: config.jwksUrl }),
        });
      claims = await verifier.verify(assertion);
    } else {
      claims = developmentClaims(context.req.raw.headers, config);
    }

    const identity = await repository.resolveAccessIdentity(
      claims,
      config.workspaceId ?? DEFAULT_WORKSPACE_ID,
      config.bootstrapOwnerEmail,
    );
    if (identity.status !== "active") {
      throw new ApiProblem("FORBIDDEN", 403, "This account is suspended");
    }
    context.set("identity", identity);
    await next();
  });
}

function developmentClaims(
  headers: Headers,
  config: AccessAuthenticationConfig,
): AccessJwtClaims {
  if (
    config.environment !== "development" ||
    config.allowDevelopmentIdentity !== true
  ) {
    throw new ApiProblem(
      "AUTHENTICATION_REQUIRED",
      401,
      "A valid Cloudflare Access session is required",
    );
  }

  const email = headers.get("X-Development-User-Email");
  const subject = headers.get("X-Development-User-Subject");
  if (email === null || subject === null) {
    throw new ApiProblem(
      "AUTHENTICATION_REQUIRED",
      401,
      "Development identity headers are required",
    );
  }
  return {
    aud: config.audience,
    email,
    exp: Math.floor(Date.now() / 1_000) + 3_600,
    iss: config.issuer,
    name: headers.get("X-Development-User-Name") ?? email,
    sub: subject,
  };
}
