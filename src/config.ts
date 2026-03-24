export const env = {
  // AI Provider (Google Gemini)
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY || '',
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.0-flash',

  // Embedding
  GOOGLE_EMBEDDING_MODEL: process.env.GOOGLE_EMBEDDING_MODEL || 'gemini-embedding-001',
  EMBEDDING_DIMENSIONS: parseInt(process.env.EMBEDDING_DIMENSIONS || '3072', 10),

  // Vector DB (Qdrant)
  QDRANT_URL: process.env.QDRANT_URL || process.env.QDRANT_HOST || 'http://localhost:6333',
  QDRANT_API_KEY: process.env.QDRANT_KEY || '',
  QDRANT_COLLECTION: process.env.QDRANT_COLLECTION || process.env.QDRANT_COLLECTION_NAME || 'permito_regulations',
  QDRANT_INCIDENTS_COLLECTION: process.env.QDRANT_INCIDENTS_COLLECTION || 'permito_incidents',
  QDRANT_COMPLIANCE_COLLECTION: process.env.QDRANT_COMPLIANCE_COLLECTION || 'permito_compliance_docs',

  // Safety thresholds
  HAZARD_CONFIDENCE_THRESHOLD: parseFloat(process.env.HAZARD_CONFIDENCE_THRESHOLD || '0.7'),
  ANOMALY_SIMILARITY_THRESHOLD: parseFloat(process.env.ANOMALY_SIMILARITY_THRESHOLD || '0.7'),
  MAX_HAZARD_SUGGESTIONS: parseInt(process.env.MAX_HAZARD_SUGGESTIONS || '10', 10),

  // AI settings
  AI_TEMPERATURE: parseFloat(process.env.AI_TEMPERATURE || '0'),
};
