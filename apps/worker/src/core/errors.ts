import type { ApiError, ApiErrorCode } from "@nago-wiki/shared";

export class ApiProblem extends Error {
  public constructor(
    public readonly code: ApiErrorCode,
    public readonly status: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiProblem";
  }
}

export function toApiErrorBody(
  problem: ApiProblem,
  requestId: string,
): ApiError {
  const error = {
    code: problem.code,
    message: problem.message,
    requestId,
    ...(problem.details === undefined ? {} : { details: problem.details }),
  };
  return { error };
}

export function isD1UniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(?:UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE)/i.test(error.message)
  );
}
