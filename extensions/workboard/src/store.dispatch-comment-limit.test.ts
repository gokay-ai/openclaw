// Dispatch comment-limit regressions split from store.test.ts (max-lines).
import { DatabaseSync } from "node:sqlite";
import { describe, expect } from "vitest";
import { computeCardDiagnostics } from "./store-card-helpers.js";
import { sqliteOnly } from "./test/sqlite-only.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";

describe("WorkboardStore dispatch comment limits", () => {
  sqliteOnly("keeps stored oversized comment bodies intact through dispatch reclaim", async () => {
    const { store, dbPath } = createWorkboardSqliteTestHarness();
    const stranded = await Promise.all(
      Array.from({ length: 18 }, (_, index) =>
        store.create({
          title: `Stranded ${index + 1}`,
          status: "ready",
          agentId: "main",
        }),
      ),
    );
    const expired = await store.create({ title: "Expired claim", status: "ready" });
    await store.update(expired.id, {
      metadata: {
        ...expired.metadata,
        claim: {
          ownerId: "main",
          token: "token-1",
          claimedAt: 1,
          lastHeartbeatAt: 1,
          expiresAt: 2,
        },
      },
    });
    const sibling = await store.create({ title: "Unaffected sibling", status: "ready" });
    const now = Date.now() + 2 * 60 * 60 * 1000;
    // Surrounding whitespace must survive too; rows are deleted and reinserted.
    const summary = stranded
      .flatMap((card) =>
        computeCardDiagnostics(card, now)
          .filter((entry) => entry.kind === "stranded_ready")
          .map((entry) => `- ${entry.kind} ${card.id}: ${entry.title}. ${entry.detail}`),
      )
      .join("\n");
    const oversized = `  ${summary}\n`;
    expect(oversized.length).toBeGreaterThan(2000);

    const rawDb = new DatabaseSync(dbPath);
    try {
      rawDb
        .prepare(
          "INSERT INTO workboard_card_comments (id, card_id, ordinal, body, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("oversized-summary", expired.id, 0, oversized, Date.now());
    } finally {
      rawDb.close();
    }

    expect((await store.get(expired.id))?.metadata?.comments?.[0]?.body).toBe(oversized);
    const dispatch = await store.dispatch(now);

    expect(dispatch.reclaimed).toEqual([expect.objectContaining({ id: expired.id })]);
    expect(dispatch.reclaimed[0]?.metadata?.claim).toBeUndefined();
    expect((await store.get(expired.id))?.metadata?.comments?.[0]?.body).toBe(oversized);
    await expect(store.get(sibling.id)).resolves.toEqual(sibling);

    const verifyDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        verifyDb
          .prepare("SELECT body FROM workboard_card_comments WHERE id = ?")
          .get("oversized-summary"),
      ).toEqual({ body: oversized });
    } finally {
      verifyDb.close();
    }

    const tooLong = "x".repeat(2001);
    await expect(store.addComment(expired.id, { body: tooLong })).rejects.toThrow(
      "comment body must be 2000 characters or fewer (got 2001).",
    );
    const stored = (await store.get(expired.id))?.metadata;
    await expect(
      store.update(expired.id, {
        metadata: {
          ...stored,
          comments: [...(stored?.comments ?? []), { id: "new", body: tooLong, createdAt: now }],
        },
      }),
    ).rejects.toThrow("comment body must be 2000 characters or fewer (got 2001).");
    await expect(
      store.update(expired.id, {
        metadata: {
          ...stored,
          comments: [{ id: "oversized-summary", body: `${oversized} edited`, createdAt: now }],
        },
      }),
    ).rejects.toThrow("comment body must be 2000 characters or fewer");
    expect((await store.get(expired.id))?.metadata?.comments?.[0]?.body).toBe(oversized);
  });
});
