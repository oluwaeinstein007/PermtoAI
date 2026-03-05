import { QdrantClient } from "@qdrant/js-client-rest";
import { env } from "../config.js";

export interface VectorSearchResult {
  id: string | number;
  score: number;
  payload: Record<string, unknown>;
}

export class VectorService {
  private client: QdrantClient;

  constructor() {
    this.client = new QdrantClient({ url: env.QDRANT_URL, apiKey: env.QDRANT_API_KEY });
  }

  /**
   * Search for relevant regulations/safety protocols based on job description.
   * Returns documents from the regulations collection.
   */
  async searchRegulations(
    queryVector: number[],
    limit: number = 5
  ): Promise<VectorSearchResult[]> {
    try {
      const results = await this.client.search(env.QDRANT_COLLECTION, {
        vector: queryVector,
        limit,
        with_payload: true,
      });

      return results.map((r) => ({
        id: r.id,
        score: r.score,
        payload: (r.payload ?? {}) as Record<string, unknown>,
      }));
    } catch (error) {
      console.error("[VectorService] Regulation search failed:", error);
      return [];
    }
  }

  /**
   * Search for similar historical incidents based on job context.
   * Used as a "missed hazard guardrail" per requirements.
   */
  async searchIncidents(
    queryVector: number[],
    limit: number = 5
  ): Promise<VectorSearchResult[]> {
    try {
      const results = await this.client.search(
        env.QDRANT_INCIDENTS_COLLECTION,
        {
          vector: queryVector,
          limit,
          with_payload: true,
        }
      );

      return results.map((r) => ({
        id: r.id,
        score: r.score,
        payload: (r.payload ?? {}) as Record<string, unknown>,
      }));
    } catch (error) {
      console.error("[VectorService] Incident search failed:", error);
      return [];
    }
  }

  /**
   * Compute cosine similarity between two permits for anomaly detection.
   */
  async findSimilarPermits(
    queryVector: number[],
    limit: number = 10
  ): Promise<VectorSearchResult[]> {
    try {
      const results = await this.client.search(env.QDRANT_COLLECTION, {
        vector: queryVector,
        limit,
        with_payload: true,
        score_threshold: env.ANOMALY_SIMILARITY_THRESHOLD,
      });

      return results.map((r) => ({
        id: r.id,
        score: r.score,
        payload: (r.payload ?? {}) as Record<string, unknown>,
      }));
    } catch (error) {
      console.error("[VectorService] Similarity search failed:", error);
      return [];
    }
  }
}
