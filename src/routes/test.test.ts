import request from "supertest";
import { app } from "../index";

describe("GET /test", () => {
  it("should return 200 with success: true", async () => {
    const response = await request(app).get("/test");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.message).toBe("Test route is working");
    expect(typeof response.body.timestamp).toBe("string");
  });

  it("should return JSON content-type", async () => {
    const response = await request(app).get("/test");

    expect(response.headers["content-type"]).toMatch(/application\/json/);
  });
});
