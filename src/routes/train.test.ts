import request from "supertest";
import { app } from "../index";
import { videoService } from "../services/video";
import { playbookService } from "../services/playbook";
import { TEST_COMPANY_ID, withAdmin, withTenant } from "../test-utils";

jest.mock("../services/video", () => ({
  videoService: {
    ingestVideo: jest.fn(),
  },
}));

jest.mock("../services/playbook", () => ({
  playbookService: {
    extractPlaybookFromYoutube: jest.fn(),
  },
}));

describe("train routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(videoService.ingestVideo).mockResolvedValue({
      skipped: false,
      sourcePath: "youtube_video:abc123",
      book: {
        // Knowledge is global → no company_id on books.
        id: "book-1",
        title: "Training Video",
        author: null,
        metadata: {},
        status: "ready",
        error: null,
        created_at: "now",
        updated_at: "now",
      },
    });
    jest.mocked(playbookService.extractPlaybookFromYoutube).mockResolvedValue({
      id: "playbook-1",
      name: "Training Video",
      company_id: TEST_COMPANY_ID,
      country_code: "GE",
      key: null,
      kind: "task",
      source_type: "youtube",
      source_path: "youtube:abc123",
      source_url: "https://youtu.be/abc123",
      duration_seconds: null,
      status: "ready",
      review_status: "pending_review",
      reviewed_at: null,
      rejected_at: null,
      extraction_warnings: [],
      steps: [],
      step_count: 0,
      model: "gemini",
      error: null,
      created_at: "now",
      updated_at: "now",
    });
  });

  it("creates global knowledge AND a per-company playbook when called by an admin", async () => {
    const response = await withAdmin(request(app).post("/train/video")).send({
      url: "https://youtu.be/abc123",
    });

    expect(response.status).toBe(201);
    expect(videoService.ingestVideo).toHaveBeenCalledWith({
      url: "https://youtu.be/abc123",
      force: false,
    });
    expect(playbookService.extractPlaybookFromYoutube).toHaveBeenCalledWith({
      companyId: TEST_COMPANY_ID,
      url: "https://youtu.be/abc123",
      force: false,
    });
    expect(response.body).toMatchObject({
      success: true,
      reviewRequired: true,
      knowledge: expect.objectContaining({ sourcePath: "youtube_video:abc123" }),
      playbook: expect.objectContaining({ review_status: "pending_review" }),
      knowledgeDeniedForCompanyUser: false,
    });
  });

  it("falls back to playbook-only when a non-admin company user calls /train/video", async () => {
    const response = await withTenant(request(app).post("/train/video")).send({
      url: "https://youtu.be/abc123",
    });

    expect(response.status).toBe(201);
    expect(videoService.ingestVideo).not.toHaveBeenCalled();
    expect(playbookService.extractPlaybookFromYoutube).toHaveBeenCalledWith({
      companyId: TEST_COMPANY_ID,
      url: "https://youtu.be/abc123",
      force: false,
    });
    expect(response.body.knowledgeDeniedForCompanyUser).toBe(true);
    expect(response.body.knowledge).toBeNull();
  });
});
