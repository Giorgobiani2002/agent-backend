import { toPgVector } from "./vector";

describe("vector utilities", () => {
  it("formats embeddings as pgvector literals", () => {
    expect(toPgVector([0.1, -2, 3])).toBe("[0.1,-2,3]");
  });
});

