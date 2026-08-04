import path from 'node:path';
import { loadConfig } from '../config.js';
import { ensureDir, readJsonFile, writeJsonFile } from '../utils/fs.js';
import { requestJson } from '../utils/http.js';
import { generateId } from '../utils/id.js';
import { createSingleton } from '../utils/singleton.js';

export interface VectorRecord {
  id: string;
  table: 'episodic' | 'catalog';
  text: string;
  vector: number[];
  metadata: any;
  timestamp: string;
}

const LOG_LABEL = '[VectorDB]';

export class VectorDbManager {
  private memoryPath: string;
  private indexPath: string;
  private isFallback: boolean = false;
  private lancedbInstance: any = null;
  
  // Pure JS Vector Store Fallback
  private index: VectorRecord[] = [];

  constructor() {
    const config = loadConfig();
    this.memoryPath = ensureDir(config.paths.memory);
    this.indexPath = path.join(this.memoryPath, 'vectors_fallback.json');

    this.initializeDb();
  }

  private initializeDb() {
    try {
      // Attempt to load lancedb dynamically
      const lancedb = require('@lancedb/lancedb');
      this.lancedbInstance = lancedb;
      console.log(`${LOG_LABEL} LanceDB successfully imported. Using LanceDB backend.`);
    } catch (e) {
      this.isFallback = true;
      console.warn(`${LOG_LABEL} Native LanceDB not available. Falling back to local JS Vector Store: ${this.indexPath}`);
      this.loadIndex();
    }
  }

  private loadIndex() {
    this.index = readJsonFile<VectorRecord[]>(this.indexPath, this.index, LOG_LABEL);
  }

  private saveIndex() {
    writeJsonFile(this.indexPath, this.index, LOG_LABEL);
  }

  // EMBEDDING GENERATOR
  public async getEmbedding(text: string, modelName: string = 'phi3:mini'): Promise<number[]> {
    const config = loadConfig();

    try {
      const data = await requestJson<{ embedding: number[] }>(`${config.ollamaUrl}/api/embeddings`, {
        label: 'Ollama embeddings',
        body: { model: modelName, prompt: text },
      });
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

  private async embedWithFastModel(text: string): Promise<number[]> {
    const config = loadConfig();
    return this.getEmbedding(text, config.modelRouting.fast);
  }

  private async connectLanceDb(): Promise<any> {
    return this.lancedbInstance.connect(path.join(this.memoryPath, 'lancedb'));
  }

  /**
   * Stores a text record in the given table, using LanceDB when available and
   * the local JS vector store otherwise.
   */
  private async addRecord(
    table: VectorRecord['table'],
    idPrefix: string,
    text: string,
    metadata: any
  ): Promise<void> {
    const record: VectorRecord = {
      id: generateId(idPrefix),
      table,
      text,
      vector: await this.embedWithFastModel(text),
      metadata,
      timestamp: new Date().toISOString(),
    };

    if (!this.isFallback) {
      try {
        const db = await this.connectLanceDb();
        let lanceTable;
        try {
          lanceTable = await db.openTable(table);
        } catch {
          await db.createTable(table, [record]);
          return;
        }
        await lanceTable.add([record]);
        return;
      } catch (err) {
        console.error(`${LOG_LABEL} LanceDB ${table} insert failed, falling back:`, err);
      }
    }

    this.index.push(record);
    this.saveIndex();
  }

  /**
   * Returns the closest matches for a query within the given table.
   */
  private async searchRecords(
    table: VectorRecord['table'],
    query: string,
    limit: number
  ): Promise<any[]> {
    const queryVector = await this.embedWithFastModel(query);

    if (!this.isFallback) {
      try {
        const db = await this.connectLanceDb();
        const lanceTable = await db.openTable(table);
        return await lanceTable.search(queryVector).limit(limit).execute();
      } catch (err) {
        console.error(`${LOG_LABEL} LanceDB ${table} search failed, falling back:`, err);
      }
    }

    return this.index
      .filter(r => r.table === table)
      .map(r => ({ ...r, score: this.cosineSimilarity(queryVector, r.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // EPISODIC MEMORY
  public async addEpisodicMemory(sessionId: string, userMessage: string, assistantMessage: string): Promise<void> {
    await this.addRecord(
      'episodic',
      'memo',
      `User: ${userMessage}\nAssistant: ${assistantMessage}`,
      { sessionId, userMessage, assistantMessage }
    );
  }

  public async searchEpisodicMemory(query: string, limit: number = 3): Promise<any[]> {
    return this.searchRecords('episodic', query, limit);
  }

  // BUSINESS CATALOG RAG
  public async addCatalogDoc(text: string, metadata: any = {}): Promise<void> {
    await this.addRecord('catalog', 'doc', text, metadata);
  }

  public async searchCatalog(query: string, limit: number = 3): Promise<any[]> {
    return this.searchRecords('catalog', query, limit);
  }

  // Clear RAG catalog to re-index
  public clearCatalog(): void {
    this.index = this.index.filter(r => r.table !== 'catalog');
    this.saveIndex();
  }
}

// Single instance export
export const getVectorDbManager = createSingleton(() => new VectorDbManager());
