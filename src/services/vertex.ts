import { GoogleGenAI } from "@google/genai";
import { config } from "../config";
import { HttpError } from "../errors";

type ServiceAccountCredentials = {
  client_email: string;
  private_key: string;
  project_id?: string;
};

let client: GoogleGenAI | null = null;
let parsedCredentials: ServiceAccountCredentials | null | undefined;

export function getVertexCredentials(): ServiceAccountCredentials | undefined {
  if (parsedCredentials !== undefined) return parsedCredentials ?? undefined;

  const raw = config.gcpServiceAccountJson?.trim();
  if (!raw) {
    parsedCredentials = null;
    return undefined;
  }

  try {
    const value = JSON.parse(raw) as Partial<ServiceAccountCredentials>;
    if (!value.client_email || !value.private_key) {
      throw new Error("client_email and private_key are required");
    }
    parsedCredentials = {
      client_email: value.client_email,
      private_key: value.private_key.replace(/\\n/g, "\n"),
      ...(value.project_id ? { project_id: value.project_id } : {}),
    };
    return parsedCredentials;
  } catch (error) {
    throw new HttpError(
      500,
      `GCP_SERVICE_ACCOUNT_JSON is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function getVertexClient(): GoogleGenAI {
  if (!client) {
    const credentials = getVertexCredentials();
    client = new GoogleGenAI({
      vertexai: true,
      project: config.gcpProjectId,
      location: config.gcpLocation,
      ...(credentials ? { googleAuthOptions: { credentials } } : {}),
    });
  }
  return client;
}

export function resetVertexClient() {
  client = null;
  parsedCredentials = undefined;
}
