import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';

export interface VectorRecord {
  id: string;
  table: 'episodic' | 'catalog';
  text: string;
  vector: number[];
  metadata: any;
  timestamp: string;
}

export class VectorDbManager {
  private memoryPath: string;
  private indexPath: string;
  private isFallback: boolean = false;
  private lancedbInstance: any = null;
  
  // Pure JS Vector Store Fallback
  private index: VectorRecord[] = [];

  constructor() {
    const config = loadConfig();
    this.memoryPath = config.paths.memory;
    this.indexPath = path.join(this.memoryPath, 'vectors_fallback.json');

    if (!fs.existsSync(this.memoryPath)) {
      fs.mkdirSync(this.memoryPath, { recursive: true });
    }

    this.initializeDb();
  }

  private initializeDb() {
    try {
      // Attempt to load lancedb dynamically
      const lancedb = require('@lancedb/lancedb');
      this.lancedbInstance = lancedb;
      console.log(`[VectorDB] LanceDB successfully imported. Using LanceDB backend.`);
    } catch (e) {
      this.isFallback = true;
      console.warn(`[VectorDB] Native LanceDB not available. Falling back to local JS Vector Store: ${this.indexPath}`);
      this.loadIndex();
    }
  }

  private loadIndex() {
    if (fs.existsSync(this.indexPath)) {
      try {
        const content = fs.readFileSync(this.indexPath, 'utf-8');
        this.index = JSON.parse(content);
      } catch (err) {
        console.error(`[VectorDB] Error reading vector file, resetting:`, err);
      }
    }
  }

  private saveIndex() {
    try {
      fs.writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2), 'utf-8');
    } catch (err) {
      console.error(`[VectorDB] Error saving vector file:`, err);
    }
  }

  // EMBEDDING GENERATOR
  public async getEmbedding(text: string, modelName: string = 'phi3:mini'): Promise<number[]> {
    const config = loadConfig();
    const url = `${config.ollamaUrl}/api/embeddings`;
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          prompt: text,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama status: ${response.status}`);
      }

      const data = await response.json() as { embedding: number[] };
      return data.embedding;
    } catch (e) {
      // Fallback: Generate a simple deterministic pseudo-embedding vector of 128 elements in case Ollama is offline
      // This is crucial for local testing without pulling/running Ollama models immediately!
      // Simple hash-based embedding
      const vector: number[] = [];
      const dimensions = 128;
      const normalizedText = text.toLowerCase();
      
      for (let i = 0; i < dimensions; i++) {
        let hash = 0;
        for (let j = 0; j < normalizedText.length; j++) {
          hash = (hash << 5) - hash + normalizedText.charCodeAt(j) + i;
          hash |= 0; // Convert to 32bit integer
        }
        vector.push(Math.sin(hash) * 0.5 + 0.5); // value between 0 and 1
      }
      
      // L2 Normalize
      const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
      return vector.map(val => val / (magnitude || 1));
    }
  }

  // COSINE SIMILARITY
  private cosineSimilarity(v1: number[], v2: number[]): number {
    if (v1.length !== v2.length) return 0;
    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;
    for (let i = 0; i < v1.length; i++) {
      dotProduct += v1[i] * v2[i];
      norm1 += v1[i] * v1[i];
      norm2 += v2[i] * v2[i];
    }
    return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2) || 1);
  }

  // EPISODIC MEMORY
  public async addEpisodicMemory(sessionId: string, userMessage: string, assistantMessage: string): Promise<void> {
    const text = `User: ${userMessage}\nAssistant: ${assistantMessage}`;
    const config = loadConfig();
    const model = config.modelRouting.fast;
    const vector = await this.getEmbedding(text, model);

    const record: VectorRecord = {
      id: `memo-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      table: 'episodic',
      text,
      vector,
      metadata: { sessionId, userMessage, assistantMessage },
      timestamp: new Date().toISOString(),
    };

    if (this.isFallback) {
      this.index.push(record);
      this.saveIndex();
    } else {
      // LanceDB insert logic
      try {
        const db = await this.lancedbInstance.connect(path.join(this.memoryPath, 'lancedb'));
        let table;
        try {
          table = await db.openTable('episodic');
        } catch {
          table = await db.createTable('episodic', [record]);
          return;
        }
        await table.add([record]);
      } catch (err) {
        console.error(`[VectorDB] LanceDB insert failed, falling back:`, err);
        this.index.push(record);
        this.saveIndex();
      }
    }
  }

  public async searchEpisodicMemory(query: string, limit: number = 3): Promise<any[]> {
    const config = loadConfig();
    const model = config.modelRouting.fast;
    const queryVector = await this.getEmbedding(query, model);

    if (this.isFallback) {
      const scored = this.index
        .filter(r => r.table === 'episodic')
        .map(r => ({
          ...r,
          score: this.cosineSimilarity(queryVector, r.vector),
        }))
        .sort((a, b) => b.score - a.score);

      return scored.slice(0, limit);
    } else {
      try {
        const db = await this.lancedbInstance.connect(path.join(this.memoryPath, 'lancedb'));
        const table = await db.openTable('episodic');
        const results = await table.search(queryVector).limit(limit).execute();
        return results;
      } catch (err) {
        console.error(`[VectorDB] LanceDB search failed, falling back:`, err);
        // JS Fallback search
        const scored = this.index
          .filter(r => r.table === 'episodic')
          .map(r => ({
            ...r,
            score: this.cosineSimilarity(queryVector, r.vector),
          }))
          .sort((a, b) => b.score - a.score);

        return scored.slice(0, limit);
      }
    }
  }

  // BUSINESS CATALOG RAG
  public async addCatalogDoc(text: string, metadata: any = {}): Promise<void> {
    const config = loadConfig();
    const model = config.modelRouting.fast;
    const vector = await this.getEmbedding(text, model);

    const record: VectorRecord = {
      id: `doc-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      table: 'catalog',
      text,
      vector,
      metadata,
      timestamp: new Date().toISOString(),
    };

    if (this.isFallback) {
      this.index.push(record);
      this.saveIndex();
    } else {
      try {
        const db = await this.lancedbInstance.connect(path.join(this.memoryPath, 'lancedb'));
        let table;
        try {
          table = await db.openTable('catalog');
        } catch {
          table = await db.createTable('catalog', [record]);
          return;
        }
        await table.add([record]);
      } catch (err) {
        console.error(`[VectorDB] LanceDB catalog insert failed, falling back:`, err);
        this.index.push(record);
        this.saveIndex();
      }
    }
  }

  public async searchCatalog(query: string, limit: number = 3): Promise<any[]> {
    const config = loadConfig();
    const model = config.modelRouting.fast;
    const queryVector = await this.getEmbedding(query, model);

    if (this.isFallback) {
      const scored = this.index
        .filter(r => r.table === 'catalog')
        .map(r => ({
          ...r,
          score: this.cosineSimilarity(queryVector, r.vector),
        }))
        .sort((a, b) => b.score - a.score);

      return scored.slice(0, limit);
    } else {
      try {
        const db = await this.lancedbInstance.connect(path.join(this.memoryPath, 'lancedb'));
        const table = await db.openTable('catalog');
        const results = await table.search(queryVector).limit(limit).execute();
        return results;
      } catch (err) {
        console.error(`[VectorDB] LanceDB catalog search failed, falling back:`, err);
        const scored = this.index
          .filter(r => r.table === 'catalog')
          .map(r => ({
            ...r,
            score: this.cosineSimilarity(queryVector, r.vector),
          }))
          .sort((a, b) => b.score - a.score);

        return scored.slice(0, limit);
      }
    }
  }

  // Clear RAG catalog to re-index
  public clearCatalog(): void {
    if (this.isFallback) {
      this.index = this.index.filter(r => r.table !== 'catalog');
      this.saveIndex();
    } else {
      try {
        // Simple fallback to clear it in cache too
        this.index = this.index.filter(r => r.table !== 'catalog');
        this.saveIndex();
      } catch {}
    }
  }
}

// Single instance export
let vectorDbInstance: VectorDbManager | null = null;
export function getVectorDbManager(): VectorDbManager {
  if (!vectorDbInstance) {
    vectorDbInstance = new VectorDbManager();
  }
  return vectorDbInstance;
}
