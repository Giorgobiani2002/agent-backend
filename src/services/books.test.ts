import { createManualBook, ingestBook, updateManualBook } from "./books";
import { GeminiService } from "./gemini";
import * as booksRepository from "../repositories/books";

jest.mock("../repositories/books");

describe("books service", () => {
  const gemini: GeminiService = {
    embed: jest.fn(async () => new Array(1536).fill(0.1)),
    generateChatResponse: jest.fn(),
    generateStructured: jest.fn(),
    generateWithTools: jest.fn(),
    validateData: jest.fn(async () => []),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(booksRepository.createBookWithChunks).mockResolvedValue({
      id: "book-1",
      title: "Book",
      author: null,
      metadata: {},
      status: "ready",
      error: null,
      created_at: "now",
      updated_at: "now",
    });
    jest.mocked(booksRepository.getBook).mockResolvedValue({
      id: "book-1",
      title: "Book",
      author: null,
      metadata: { source: "api", rawText: "Old text" },
      status: "ready",
      error: null,
      created_at: "now",
      updated_at: "now",
    });
    jest.mocked(booksRepository.replaceBookContent).mockResolvedValue({
      id: "book-1",
      title: "Book Updated",
      author: null,
      metadata: { source: "api", rawText: "Updated text" },
      status: "ready",
      error: null,
      created_at: "now",
      updated_at: "later",
    });
  });

  it("embeds book chunks with gemini-embedding document prompts", async () => {
    await ingestBook(
      {
        title: "Book",
        text: "A long enough book text to embed.",
        metadata: {},
      },
      gemini,
    );

    expect(gemini.embed).toHaveBeenCalledWith(
      expect.stringContaining("title: Book | text:"),
    );
    expect(booksRepository.createBookWithChunks).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Book",
        chunks: expect.arrayContaining([
          expect.objectContaining({
            embedding: expect.any(Array),
          }),
        ]),
      }),
    );
  });

  it("rejects empty book text", async () => {
    await expect(
      ingestBook({ title: "Book", text: " ", metadata: {} }, gemini),
    ).rejects.toMatchObject({
      status: 400,
      message: "text is required",
    });
  });

  it("stores raw text when creating manual knowledge", async () => {
    await createManualBook(
      {
        title: "Book",
        text: "Manual knowledge body",
      },
      gemini,
    );

    expect(booksRepository.createBookWithChunks).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          source: "api",
          rawText: "Manual knowledge body",
        }),
      }),
    );
  });

  it("replaces chunks when updating editable manual knowledge", async () => {
    await updateManualBook(
      {
        id: "book-1",
        title: "Book Updated",
        text: "Updated text",
      },
      gemini,
    );

    expect(booksRepository.replaceBookContent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "book-1",
        title: "Book Updated",
        metadata: expect.objectContaining({
          source: "api",
          rawText: "Updated text",
        }),
        chunks: expect.any(Array),
      }),
    );
  });

  it("rejects updates for non-editable imported knowledge", async () => {
    jest.mocked(booksRepository.getBook).mockResolvedValueOnce({
      id: "book-2",
      title: "Video",
      author: null,
      metadata: { source: "youtube_video" },
      status: "ready",
      error: null,
      created_at: "now",
      updated_at: "now",
    });

    await expect(
      updateManualBook(
        {
          id: "book-2",
          title: "Video",
          text: "Updated text",
        },
        gemini,
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: "Only manual text knowledge can be edited",
    });
  });
});
