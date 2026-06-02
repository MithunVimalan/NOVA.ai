import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';

export interface Fact {
  key: string;
  value: string;
  updatedAt: string;
}

export interface VisitorEvent {
  id?: number;
  sessionId: string;
  pageUrl: string;
  referrer: string;
  scrollDepth: number;
  timeOnPage: number;
  timestamp: string;
}

export interface Lead {
  id?: number;
  sessionId: string;
  name: string;
  email: string;
  capturedAt: string;
}

export class SqliteManager {
  private memoryPath: string;
  private dbPath: string;
  private isFallback: boolean = false;
  private dbInstance: any = null;

  // Fallback JSON in-memory cache
  private cache: {
    facts: Record<string, Fact>;
    visitors: VisitorEvent[];
    leads: Lead[];
  } = { facts: {}, visitors: [], leads: [] };

  constructor() {
    const config = loadConfig();
    this.memoryPath = config.paths.memory;
    this.dbPath = path.join(this.memoryPath, 'nova.db');

    // Ensure memory folder exists
    if (!fs.existsSync(this.memoryPath)) {
      fs.mkdirSync(this.memoryPath, { recursive: true });
    }

    this.initializeDb();
  }

  private initializeDb() {
    try {
      // Attempt to load better-sqlite3 dynamically
      const Database = require('better-sqlite3');
      this.dbInstance = new Database(this.dbPath);
      this.setupTables();
      console.log(`[Database] Initialized SQLite at ${this.dbPath}`);
    } catch (e) {
      this.isFallback = true;
      this.dbPath = path.join(this.memoryPath, 'nova_db_fallback.json');
      console.warn(`[Database] Native SQLite not available. Falling back to local JSON: ${this.dbPath}`);
      this.loadFallbackData();
    }
  }

  private setupTables() {
    if (this.isFallback || !this.dbInstance) return;

    this.dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS visitors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        page_url TEXT,
        referrer TEXT,
        scroll_depth INTEGER,
        time_on_page INTEGER,
        timestamp TEXT
      );
      CREATE TABLE IF NOT EXISTS leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        name TEXT,
        email TEXT,
        captured_at TEXT
      );
    `);
  }

  // FALLBACK JSON DATABASE SYSTEM
  private loadFallbackData() {
    if (fs.existsSync(this.dbPath)) {
      try {
        const content = fs.readFileSync(this.dbPath, 'utf-8');
        this.cache = JSON.parse(content);
        if (!this.cache.facts) this.cache.facts = {};
        if (!this.cache.visitors) this.cache.visitors = [];
        if (!this.cache.leads) this.cache.leads = [];
      } catch (err) {
        console.error(`[Database] Error reading fallback DB file, resetting:`, err);
      }
    } else {
      this.saveFallbackData();
    }
  }

  private saveFallbackData() {
    try {
      fs.writeFileSync(this.dbPath, JSON.stringify(this.cache, null, 2), 'utf-8');
    } catch (err) {
      console.error(`[Database] Error writing fallback DB file:`, err);
    }
  }

  // PROFILE FACTS OPERATIONS
  public getFact(key: string): string | null {
    if (this.isFallback) {
      return this.cache.facts[key]?.value || null;
    } else {
      try {
        const stmt = this.dbInstance.prepare('SELECT value FROM facts WHERE key = ?');
        const row = stmt.get(key);
        return row ? row.value : null;
      } catch (e) {
        console.error(`[Database] getFact failed:`, e);
        return null;
      }
    }
  }

  public setFact(key: string, value: string): void {
    const now = new Date().toISOString();
    if (this.isFallback) {
      this.cache.facts[key] = { key, value, updatedAt: now };
      this.saveFallbackData();
    } else {
      try {
        const stmt = this.dbInstance.prepare(`
          INSERT INTO facts (key, value, updated_at) 
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
        `);
        stmt.run(key, value, now);
      } catch (e) {
        console.error(`[Database] setFact failed:`, e);
      }
    }
  }

  public getAllFacts(): Record<string, string> {
    const result: Record<string, string> = {};
    if (this.isFallback) {
      for (const [k, f] of Object.entries(this.cache.facts)) {
        result[k] = f.value;
      }
    } else {
      try {
        const stmt = this.dbInstance.prepare('SELECT key, value FROM facts');
        const rows = stmt.all() as { key: string; value: string }[];
        for (const row of rows) {
          result[row.key] = row.value;
        }
      } catch (e) {
        console.error(`[Database] getAllFacts failed:`, e);
      }
    }
    return result;
  }

  // VISITOR TRACKING OPERATIONS
  public logVisitorEvent(event: Omit<VisitorEvent, 'timestamp'>): void {
    const timestamp = new Date().toISOString();
    if (this.isFallback) {
      const newEvent: VisitorEvent = {
        id: this.cache.visitors.length + 1,
        ...event,
        timestamp,
      };
      this.cache.visitors.push(newEvent);
      this.saveFallbackData();
    } else {
      try {
        const stmt = this.dbInstance.prepare(`
          INSERT INTO visitors (session_id, page_url, referrer, scroll_depth, time_on_page, timestamp)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(event.sessionId, event.pageUrl, event.referrer, event.scrollDepth, event.timeOnPage, timestamp);
      } catch (e) {
        console.error(`[Database] logVisitorEvent failed:`, e);
      }
    }
  }

  public getVisitorLogs(): VisitorEvent[] {
    if (this.isFallback) {
      return [...this.cache.visitors].reverse();
    } else {
      try {
        const stmt = this.dbInstance.prepare('SELECT * FROM visitors ORDER BY id DESC');
        return stmt.all() as VisitorEvent[];
      } catch (e) {
        console.error(`[Database] getVisitorLogs failed:`, e);
        return [];
      }
    }
  }

  // LEAD CONVERSION OPERATIONS
  public addLead(lead: Omit<Lead, 'capturedAt'>): void {
    const capturedAt = new Date().toISOString();
    if (this.isFallback) {
      const newLead: Lead = {
        id: this.cache.leads.length + 1,
        ...lead,
        capturedAt,
      };
      this.cache.leads.push(newLead);
      this.saveFallbackData();
    } else {
      try {
        const stmt = this.dbInstance.prepare(`
          INSERT INTO leads (session_id, name, email, captured_at)
          VALUES (?, ?, ?, ?)
        `);
        stmt.run(lead.sessionId, lead.name, lead.email, capturedAt);
      } catch (e) {
        console.error(`[Database] addLead failed:`, e);
      }
    }
  }

  public getLeads(): Lead[] {
    if (this.isFallback) {
      return [...this.cache.leads].reverse();
    } else {
      try {
        const stmt = this.dbInstance.prepare('SELECT * FROM leads ORDER BY id DESC');
        return stmt.all() as Lead[];
      } catch (e) {
        console.error(`[Database] getLeads failed:`, e);
        return [];
      }
    }
  }
}

// Single instance exports
let sqliteManagerInstance: SqliteManager | null = null;
export function getSqliteManager(): SqliteManager {
  if (!sqliteManagerInstance) {
    sqliteManagerInstance = new SqliteManager();
  }
  return sqliteManagerInstance;
}
