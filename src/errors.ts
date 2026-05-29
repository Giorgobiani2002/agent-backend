export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function getErrorStatus(error: unknown, fallback = 500): number {
  if (error instanceof HttpError) {
    return error.status;
  }

  if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }

  return fallback;
}

export function getErrorMessage(error: unknown, fallback = "Internal server error"): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  return fallback;
}
