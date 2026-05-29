import request from "supertest";
import { app } from "../index";
import { booksService } from "../services/books";
import { withAdmin, withTenant } from "../test-utils";

describe("books routes", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("creates a book through the ingestion service (admin only)", async () => {
    jest.spyOn(booksService, "createManualBook").mockResolvedValue({
      id: "book-1",
      title: "Book",
      author: null,
      metadata: { source: "api", rawText: "Book text" },
      status: "ready",
      error: null,
      created_at: "now",
      updated_at: "now",
      chunk_count: "1",
    });

    const response = await withAdmin(request(app).post("/books")).send({
      title: "Book",
      text: "Book text",
    });

    expect(response.status).toBe(201);
    expect(response.body.book.editable).toBe(true);
    expect(booksService.createManualBook).toHaveBeenCalledWith({
      title: "Book",
      author: undefined,
      text: "Book text",
      metadata: {},
    });
  });

  it("rejects book creation from a non-admin company user with 403", async () => {
    const spy = jest.spyOn(booksService, "createManualBook");
    const response = await withTenant(request(app).post("/books")).send({
      title: "Book",
      text: "Book text",
    });

    expect(response.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns 400 for empty book text (admin)", async () => {
    jest.spyOn(booksService, "createManualBook").mockRejectedValue({
      status: 400,
      message: "text is required",
    });

    const response = await withAdmin(request(app).post("/books")).send({
      title: "Book",
      text: " ",
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe("text is required");
  });

  it("imports PDFs from the data folder (admin)", async () => {
    jest.spyOn(booksService, "ingestPdfDirectory").mockResolvedValue({
      directory: "/data",
      total: 2,
      imported: 1,
      skipped: 1,
      failed: 0,
      results: [],
    });

    const response = await withAdmin(request(app).post("/books/import-data")).send({});

    expect(response.status).toBe(200);
    expect(response.body.imported).toBe(1);
    expect(booksService.ingestPdfDirectory).toHaveBeenCalledWith({ force: false });
  });

  it("lists normalized knowledge sources for any company user", async () => {
    jest.spyOn(booksService, "listKnowledgeBooks").mockResolvedValue([
      {
        id: "book-1",
        title: "Manual",
        author: null,
        metadata: { source: "api" },
        status: "ready",
        error: null,
        created_at: "now",
        updated_at: "now",
        chunk_count: "2",
      },
    ]);

    const response = await withTenant(request(app).get("/books"));

    expect(response.status).toBe(200);
    expect(response.body.books[0]).toMatchObject({
      id: "book-1",
      source_type: "api",
      source_label: "Manual text",
      editable: true,
      chunk_count: 2,
    });
  });

  it("returns knowledge details with chunks for any company user", async () => {
    jest.spyOn(booksService, "getKnowledgeBook").mockResolvedValue({
      book: {
        id: "book-1",
        title: "Manual",
        author: null,
        metadata: { source: "api", rawText: "Body" },
        status: "ready",
        error: null,
        created_at: "now",
        updated_at: "now",
        chunk_count: "1",
      },
      chunks: [
        {
          id: "chunk-1",
          book_id: "book-1",
          chunk_index: 0,
          content: "Body",
          token_count: 1,
          char_count: 4,
          metadata: { source: "api" },
        },
      ],
    });

    const response = await withTenant(request(app).get("/books/book-1"));

    expect(response.status).toBe(200);
    expect(response.body.book.raw_text).toBe("Body");
    expect(response.body.book.chunks).toHaveLength(1);
  });

  it("updates manual knowledge through patch (admin)", async () => {
    jest.spyOn(booksService, "updateManualBook").mockResolvedValue({
      id: "book-1",
      title: "Updated",
      author: null,
      metadata: { source: "api", rawText: "Updated body" },
      status: "ready",
      error: null,
      created_at: "now",
      updated_at: "later",
      chunk_count: "1",
    });

    const response = await withAdmin(request(app).patch("/books/book-1")).send({
      title: "Updated",
      text: "Updated body",
    });

    expect(response.status).toBe(200);
    expect(booksService.updateManualBook).toHaveBeenCalledWith({
      id: "book-1",
      title: "Updated",
      author: undefined,
      text: "Updated body",
      metadata: {},
    });
  });

  it("deletes knowledge sources (admin)", async () => {
    jest.spyOn(booksService, "deleteKnowledgeBook").mockResolvedValue(undefined);

    const response = await withAdmin(request(app).delete("/books/book-1"));

    expect(response.status).toBe(200);
    expect(booksService.deleteKnowledgeBook).toHaveBeenCalledWith("book-1");
  });
});
