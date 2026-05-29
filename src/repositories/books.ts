import { PoolClient } from "pg";
import { query, withTransaction } from "../db";
import { toPgVector } from "../utils/vector";

// Knowledge is global, shared across companies. Only platform admins seed it.
// All search/list/get/update/delete functions in this file are NOT scoped by
// company on purpose — see migration 014_global_knowledge.sql.

export interface BookRow {
  id: string;
  title: string;
  author: string | null;
  metadata: Record<string, unknown>;
  status: "pending" | "ready" | "failed";
  error: string | null;
  created_at: string;
  updated_at: string;
  chunk_count?: string;
}

export interface BookWithChunks {
  book: BookRow;
  chunks: BookChunkRow[];
}

export interface BookChunkRow {
  id: string;
  book_id: string;
  chunk_index: number;
  content: string;
  token_count: number;
  char_count: number;
  metadata: Record<string, unknown>;
  similarity?: number;
  rank?: number;
  book_title?: string;
  book_metadata?: Record<string, unknown>;
}

export interface CreateChunkInput {
  chunkIndex: number;
  content: string;
  tokenCount: number;
  charCount: number;
  metadata: Record<string, unknown>;
  embedding: number[];
}

export async function createBookWithChunks(input: {
  title: string;
  author?: string;
  metadata: Record<string, unknown>;
  chunks: CreateChunkInput[];
}): Promise<BookRow> {
  return withTransaction(async (client) => {
    const bookResult = await client.query<BookRow>(
      `
        INSERT INTO books (title, author, metadata, status)
        VALUES ($1, $2, $3, 'ready')
        RETURNING *
      `,
      [input.title, input.author ?? null, input.metadata],
    );

    const book = bookResult.rows[0];

    for (const chunk of input.chunks) {
      await client.query(
        `
          INSERT INTO book_chunks (
            book_id,
            chunk_index,
            content,
            token_count,
            char_count,
            metadata,
            embedding
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
        `,
        [
          book.id,
          chunk.chunkIndex,
          chunk.content,
          chunk.tokenCount,
          chunk.charCount,
          chunk.metadata,
          toPgVector(chunk.embedding),
        ],
      );
    }

    return book;
  });
}

export async function createFailedBook(input: {
  title: string;
  author?: string;
  metadata: Record<string, unknown>;
  error: string;
}): Promise<BookRow> {
  const result = await query<BookRow>(
    `
      INSERT INTO books (title, author, metadata, status, error)
      VALUES ($1, $2, $3, 'failed', $4)
      RETURNING *
    `,
    [input.title, input.author ?? null, input.metadata, input.error],
  );

  return result.rows[0];
}

export async function listBooks(): Promise<BookRow[]> {
  const result = await query<BookRow>(
    `
      SELECT books.*, COUNT(book_chunks.id)::text AS chunk_count
      FROM books
      LEFT JOIN book_chunks ON book_chunks.book_id = books.id
      GROUP BY books.id
      ORDER BY books.created_at DESC
    `,
  );

  return result.rows;
}

export async function listBooksWithFilters(_input?: {
  search?: string;
  sourceType?: string;
}): Promise<BookRow[]> {
  return listBooks();
}

export async function getBook(id: string): Promise<BookRow | null> {
  const result = await query<BookRow>(
    `
      SELECT books.*, COUNT(book_chunks.id)::text AS chunk_count
      FROM books
      LEFT JOIN book_chunks ON book_chunks.book_id = books.id
      WHERE books.id = $1
      GROUP BY books.id
    `,
    [id],
  );

  return result.rows[0] ?? null;
}

export async function getBookWithChunks(id: string): Promise<BookWithChunks | null> {
  const book = await getBook(id);

  if (!book) {
    return null;
  }

  const result = await query<BookChunkRow>(
    `
      SELECT
        id,
        book_id,
        chunk_index,
        content,
        token_count,
        char_count,
        metadata
      FROM book_chunks
      WHERE book_id = $1
      ORDER BY chunk_index ASC
    `,
    [id],
  );

  return {
    book,
    chunks: result.rows,
  };
}

export async function findBookBySourcePath(sourcePath: string): Promise<BookRow | null> {
  const result = await query<BookRow>(
    `
      SELECT books.*, COUNT(book_chunks.id)::text AS chunk_count
      FROM books
      LEFT JOIN book_chunks ON book_chunks.book_id = books.id
      WHERE books.metadata->>'sourcePath' = $1
      GROUP BY books.id
      ORDER BY books.created_at DESC
      LIMIT 1
    `,
    [sourcePath],
  );

  return result.rows[0] ?? null;
}

export async function replaceBookContent(input: {
  id: string;
  title: string;
  author?: string;
  metadata: Record<string, unknown>;
  chunks: CreateChunkInput[];
}): Promise<BookRow | null> {
  return withTransaction(async (client) => {
    const existing = await client.query<BookRow>(
      `
        SELECT *
        FROM books
        WHERE id = $1
        FOR UPDATE
      `,
      [input.id],
    );

    if (!existing.rows[0]) {
      return null;
    }

    const updatedResult = await client.query<BookRow>(
      `
        UPDATE books
        SET
          title = $2,
          author = $3,
          metadata = $4,
          updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [input.id, input.title, input.author ?? null, input.metadata],
    );

    await client.query(`DELETE FROM book_chunks WHERE book_id = $1`, [input.id]);

    for (const chunk of input.chunks) {
      await client.query(
        `
          INSERT INTO book_chunks (
            book_id,
            chunk_index,
            content,
            token_count,
            char_count,
            metadata,
            embedding
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
        `,
        [
          input.id,
          chunk.chunkIndex,
          chunk.content,
          chunk.tokenCount,
          chunk.charCount,
          chunk.metadata,
          toPgVector(chunk.embedding),
        ],
      );
    }

    return updatedResult.rows[0] ?? null;
  });
}

export async function deleteBook(id: string): Promise<boolean> {
  const result = await query<{ id: string }>(
    `
      DELETE FROM books
      WHERE id = $1
      RETURNING id
    `,
    [id],
  );

  return (result.rowCount ?? 0) > 0;
}

export async function searchBookChunks(
  embedding: number[],
  limit: number,
): Promise<BookChunkRow[]> {
  const result = await query<BookChunkRow>(
    `
      SELECT
        book_chunks.id,
        book_chunks.book_id,
        book_chunks.chunk_index,
        book_chunks.content,
        book_chunks.token_count,
        book_chunks.char_count,
        book_chunks.metadata,
        books.title AS book_title,
        books.metadata AS book_metadata,
        1 - (book_chunks.embedding <=> $1::vector) AS similarity,
        row_number() OVER (ORDER BY book_chunks.embedding <=> $1::vector)::integer AS rank
      FROM book_chunks
      JOIN books ON books.id = book_chunks.book_id
      WHERE books.status = 'ready'
      ORDER BY book_chunks.embedding <=> $1::vector
      LIMIT $2
    `,
    [toPgVector(embedding), limit],
  );

  return result.rows;
}

export async function searchBookChunksWithNeighbors(
  embedding: number[],
  seedLimit: number,
  neighborWindow: number,
  maxContextChunks: number,
  taskKind?: string,
): Promise<BookChunkRow[]> {
  // R3: when caller supplies a task kind (e.g. "vat_monthly"), prefer books
  // whose metadata.tags or .topic field matches. Soft preference — multiplied
  // distance reduces by ~40% on tag hit, which moves matching chunks up the
  // ranking without hard-filtering them out (so we degrade gracefully on
  // empty tag taxonomies). The match is case-insensitive substring.
  const kind = (taskKind ?? "").trim().toLowerCase();
  const tagBoostExpr = kind
    ? `CASE WHEN
         lower(coalesce(books.metadata->>'topic','')) LIKE '%' || $5 || '%'
         OR lower(coalesce(books.metadata->>'tags','')) LIKE '%' || $5 || '%'
         OR lower(books.title) LIKE '%' || $5 || '%'
       THEN 0.6 ELSE 1.0 END`
    : `1.0`;
  const params: unknown[] = [toPgVector(embedding), seedLimit, neighborWindow, maxContextChunks];
  if (kind) params.push(kind);

  const result = await query<BookChunkRow>(
    `
      WITH seeds AS (
        SELECT
          book_chunks.id,
          book_chunks.book_id,
          book_chunks.chunk_index,
          (book_chunks.embedding <=> $1::vector) * ${tagBoostExpr} AS distance,
          row_number() OVER (ORDER BY (book_chunks.embedding <=> $1::vector) * ${tagBoostExpr})::integer AS seed_rank
        FROM book_chunks
        JOIN books ON books.id = book_chunks.book_id
        WHERE books.status = 'ready'
        ORDER BY (book_chunks.embedding <=> $1::vector) * ${tagBoostExpr}
        LIMIT $2
      ),
      expanded AS (
        SELECT
          book_chunks.id,
          book_chunks.book_id,
          book_chunks.chunk_index,
          book_chunks.content,
          book_chunks.token_count,
          book_chunks.char_count,
          book_chunks.metadata,
          books.title AS book_title,
          books.metadata AS book_metadata,
          1 - (book_chunks.embedding <=> $1::vector) AS similarity,
          MIN(seeds.seed_rank)::integer AS seed_rank
        FROM book_chunks
        JOIN books ON books.id = book_chunks.book_id
        JOIN seeds ON
          seeds.book_id = book_chunks.book_id
          AND book_chunks.chunk_index BETWEEN
            GREATEST(seeds.chunk_index - $3, 0)
            AND seeds.chunk_index + $3
        WHERE books.status = 'ready'
        GROUP BY
          book_chunks.id,
          book_chunks.book_id,
          book_chunks.chunk_index,
          book_chunks.content,
          book_chunks.token_count,
          book_chunks.char_count,
          book_chunks.metadata,
          books.title,
          books.metadata,
          book_chunks.embedding
      )
      SELECT
        id,
        book_id,
        chunk_index,
        content,
        token_count,
        char_count,
        metadata,
        book_title,
        book_metadata,
        similarity,
        row_number() OVER (ORDER BY seed_rank, book_id, chunk_index)::integer AS rank
      FROM expanded
      ORDER BY seed_rank, book_id, chunk_index
      LIMIT $4
    `,
    params,
  );

  return result.rows;
}

export async function loadChunksForBooks(bookIds: string[]): Promise<BookChunkRow[]> {
  if (!bookIds.length) {
    return [];
  }

  const result = await query<BookChunkRow>(
    `
      SELECT
        book_chunks.id,
        book_chunks.book_id,
        book_chunks.chunk_index,
        book_chunks.content,
        book_chunks.token_count,
        book_chunks.char_count,
        book_chunks.metadata,
        books.title AS book_title,
        books.metadata AS book_metadata
      FROM book_chunks
      JOIN books ON books.id = book_chunks.book_id
      WHERE book_chunks.book_id = ANY($1::uuid[])
        AND books.status = 'ready'
      ORDER BY book_chunks.book_id, book_chunks.chunk_index
    `,
    [bookIds],
  );

  return result.rows;
}

export async function insertMessageContexts(
  client: PoolClient,
  messageId: string,
  chunks: BookChunkRow[],
): Promise<void> {
  for (const chunk of chunks) {
    await client.query(
      `
        INSERT INTO message_contexts (message_id, book_chunk_id, rank, similarity, metadata)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [
        messageId,
        chunk.id,
        chunk.rank ?? 0,
        chunk.similarity ?? 0,
        { bookId: chunk.book_id, chunkIndex: chunk.chunk_index },
      ],
    );
  }
}
