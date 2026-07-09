describe("Vertex client", () => {
  const previousEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...previousEnv };
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.dontMock("@google/genai");
    process.env = previousEnv;
  });

  it("creates the shared GoogleGenAI client in Vertex AI mode", async () => {
    const GoogleGenAI = jest.fn();
    process.env.GCP_PROJECT_ID = "vertex-project";
    process.env.GCP_LOCATION = "global";
    process.env.GEMINI_API_KEY = "unused-api-key";
    delete process.env.GCP_SERVICE_ACCOUNT_JSON;
    jest.doMock("@google/genai", () => ({ GoogleGenAI }));

    const { getVertexClient } = await import("./vertex");
    getVertexClient();

    expect(GoogleGenAI).toHaveBeenCalledWith({
      enterprise: true,
      project: "vertex-project",
      location: "global",
    });
  });

  it("passes service account JSON through Google auth options", async () => {
    const GoogleGenAI = jest.fn();
    process.env.GCP_PROJECT_ID = "vertex-project";
    process.env.GCP_LOCATION = "global";
    process.env.GCP_SERVICE_ACCOUNT_JSON = JSON.stringify({
      client_email: "declario@example.iam.gserviceaccount.com",
      private_key: "line1\\nline2",
      project_id: "vertex-project",
    });
    jest.doMock("@google/genai", () => ({ GoogleGenAI }));

    const { getVertexClient } = await import("./vertex");
    getVertexClient();

    expect(GoogleGenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        enterprise: true,
        project: "vertex-project",
        location: "global",
        googleAuthOptions: {
          credentials: {
            client_email: "declario@example.iam.gserviceaccount.com",
            private_key: "line1\nline2",
            project_id: "vertex-project",
          },
          scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        },
      }),
    );
  });
});
