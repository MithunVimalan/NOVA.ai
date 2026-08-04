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

export interface Tenant {
  id: string;
  name: string;
  telegramEnabled: number;
  telegramToken: string;
  whatsappEnabled: number;
  whatsappToken: string;
  stripeStatus: string;
}

export interface SalesLog {
  id?: number;
  productId: string;
  revenue: number;
  customer: string;
  timestamp: string;
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
    tenants: Tenant[];
    sales: SalesLog[];
  } = { facts: {}, visitors: [], leads: [], tenants: [], sales: [] };

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
      this.dbInstance.pragma('journal_mode = WAL');
      this.setupTables();
      console.log(`[Database] Initialized SQLite at ${this.dbPath} (WAL Mode enabled)`);
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
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        name TEXT,
        telegram_enabled INTEGER DEFAULT 0,
        telegram_token TEXT,
        whatsapp_enabled INTEGER DEFAULT 0,
        whatsapp_token TEXT,
        stripe_status TEXT DEFAULT 'active'
      );
      CREATE TABLE IF NOT EXISTS sales_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id TEXT,
        revenue REAL,
        customer TEXT,
        timestamp TEXT
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
        if (!this.cache.tenants) this.cache.tenants = [];
        if (!this.cache.sales) this.cache.sales = [];
      } catch (err) {
        console.error(`[Database] Fallback DB file is unreadable or corrupt, resetting to an empty database:`, err);
        this.cache = { facts: {}, visitors: [], leads: [], tenants: [], sales: [] };
        const backupPath = `${this.dbPath}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(this.dbPath, backupPath);
          console.warn(`[Database] Preserved the corrupt fallback DB at ${backupPath}`);
        } catch (backupErr) {
          throw new Error(
            `[Database] Fallback DB at ${this.dbPath} is corrupt and could not be moved aside: ${(backupErr as Error).message}`,
            { cause: backupErr }
          );
        }
        this.saveFallbackData();
      }
    } else {
      this.saveFallbackData();
    }
  }

  private saveFallbackData() {
    try {
      fs.writeFileSync(this.dbPath, JSON.stringify(this.cache, null, 2), 'utf-8');
    } catch (err) {
      throw new Error(`[Database] Failed to persist fallback DB to ${this.dbPath}: ${(err as Error).message}`, { cause: err });
    }
  }

  /**
   * Runs a native SQLite operation, rethrowing failures with context so callers
   * can distinguish a database error from an empty result.
   */
  private run<T>(label: string, operation: () => T): T {
    try {
      return operation();
    } catch (err) {
      throw new Error(`[Database] ${label} failed: ${(err as Error).message}`, { cause: err });
    }
  }

  // PROFILE FACTS OPERATIONS
  public getFact(key: string): string | null {
    if (this.isFallback) {
      return this.cache.facts[key]?.value || null;
    } else {
      return this.run('getFact', () => {
        const stmt = this.dbInstance.prepare('SELECT value FROM facts WHERE key = ?');
        const row = stmt.get(key);
        return row ? row.value : null;
      });
    }
  }

  public setFact(key: string, value: string): void {
    const now = new Date().toISOString();
    if (this.isFallback) {
      this.cache.facts[key] = { key, value, updatedAt: now };
      this.saveFallbackData();
    } else {
      this.run('setFact', () => {
        const stmt = this.dbInstance.prepare(`
          INSERT INTO facts (key, value, updated_at) 
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
        `);
        stmt.run(key, value, now);
      });
    }
  }

  public getAllFacts(): Record<string, string> {
    const result: Record<string, string> = {};
    if (this.isFallback) {
      for (const [k, f] of Object.entries(this.cache.facts)) {
        result[k] = f.value;
      }
    } else {
      const rows = this.run('getAllFacts', () =>
        this.dbInstance.prepare('SELECT key, value FROM facts').all() as { key: string; value: string }[]
      );
      for (const row of rows) {
        result[row.key] = row.value;
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
      this.run('logVisitorEvent', () => {
        const stmt = this.dbInstance.prepare(`
          INSERT INTO visitors (session_id, page_url, referrer, scroll_depth, time_on_page, timestamp)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(event.sessionId, event.pageUrl, event.referrer, event.scrollDepth, event.timeOnPage, timestamp);
      });
    }
  }

  public getVisitorLogs(): VisitorEvent[] {
    if (this.isFallback) {
      return [...this.cache.visitors].reverse();
    } else {
      return this.run('getVisitorLogs', () =>
        this.dbInstance.prepare('SELECT * FROM visitors ORDER BY id DESC').all() as VisitorEvent[]
      );
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
      this.run('addLead', () => {
        const stmt = this.dbInstance.prepare(`
          INSERT INTO leads (session_id, name, email, captured_at)
          VALUES (?, ?, ?, ?)
        `);
        stmt.run(lead.sessionId, lead.name, lead.email, capturedAt);
      });
    }
  }

  public getLeads(): Lead[] {
    if (this.isFallback) {
      return [...this.cache.leads].reverse();
    } else {
      return this.run('getLeads', () =>
        this.dbInstance.prepare('SELECT * FROM leads ORDER BY id DESC').all() as Lead[]
      );
    }
  }

  // TENANT OPERATIONS
  public addTenant(tenant: Tenant): void {
    if (this.isFallback) {
      this.cache.tenants = this.cache.tenants || [];
      const idx = this.cache.tenants.findIndex(t => t.id === tenant.id);
      if (idx >= 0) {
        this.cache.tenants[idx] = tenant;
      } else {
        this.cache.tenants.push(tenant);
      }
      this.saveFallbackData();
    } else {
      this.run('addTenant', () => {
        const stmt = this.dbInstance.prepare(`
          INSERT INTO tenants (id, name, telegram_enabled, telegram_token, whatsapp_enabled, whatsapp_token, stripe_status)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET 
            name=excluded.name,
            telegram_enabled=excluded.telegram_enabled,
            telegram_token=excluded.telegram_token,
            whatsapp_enabled=excluded.whatsapp_enabled,
            whatsapp_token=excluded.whatsapp_token,
            stripe_status=excluded.stripe_status
        `);
        stmt.run(
          tenant.id,
          tenant.name,
          tenant.telegramEnabled,
          tenant.telegramToken,
          tenant.whatsappEnabled,
          tenant.whatsappToken,
          tenant.stripeStatus
        );
      });
    }
  }

  public getTenant(id: string): Tenant | null {
    if (this.isFallback) {
      this.cache.tenants = this.cache.tenants || [];
      return this.cache.tenants.find(t => t.id === id) || null;
    } else {
      return this.run('getTenant', () => {
        const stmt = this.dbInstance.prepare('SELECT * FROM tenants WHERE id = ?');
        const row = stmt.get(id);
        if (!row) return null;
        return {
          id: row.id,
          name: row.name,
          telegramEnabled: row.telegram_enabled,
          telegramToken: row.telegram_token,
          whatsappEnabled: row.whatsapp_enabled,
          whatsappToken: row.whatsapp_token,
          stripeStatus: row.stripe_status
        };
      });
    }
  }

  public getAllTenants(): Tenant[] {
    if (this.isFallback) {
      return this.cache.tenants || [];
    } else {
      return this.run('getAllTenants', () => {
        const rows = this.dbInstance.prepare('SELECT * FROM tenants').all() as any[];
        return rows.map(row => ({
          id: row.id,
          name: row.name,
          telegramEnabled: row.telegram_enabled,
          telegramToken: row.telegram_token,
          whatsappEnabled: row.whatsapp_enabled,
          whatsappToken: row.whatsapp_token,
          stripeStatus: row.stripe_status
        }));
      });
    }
  }

  // SALES TRACKING OPERATIONS
  public logSale(sale: Omit<SalesLog, 'timestamp'> & { timestamp?: string }): void {
    const timestamp = sale.timestamp || new Date().toISOString();
    if (this.isFallback) {
      this.cache.sales = this.cache.sales || [];
      const newSale: SalesLog = {
        id: this.cache.sales.length + 1,
        ...sale,
        timestamp,
      };
      this.cache.sales.push(newSale);
      this.saveFallbackData();
    } else {
      this.run('logSale', () => {
        const stmt = this.dbInstance.prepare(`
          INSERT INTO sales_logs (product_id, revenue, customer, timestamp)
          VALUES (?, ?, ?, ?)
        `);
        stmt.run(sale.productId, sale.revenue, sale.customer, timestamp);
      });
    }
  }

  public getSalesLogs(): SalesLog[] {
    if (this.isFallback) {
      return [...(this.cache.sales || [])].reverse();
    } else {
      return this.run('getSalesLogs', () => {
        const rows = this.dbInstance.prepare('SELECT * FROM sales_logs ORDER BY timestamp DESC').all() as any[];
        return rows.map(r => ({
          id: r.id,
          productId: r.product_id,
          revenue: r.revenue,
          customer: r.customer,
          timestamp: r.timestamp,
        }));
      });
    }
  }

  public close(): void {
    if (!this.isFallback && this.dbInstance) {
      try {
        this.dbInstance.close();
        console.log('[Database] SQLite database connection closed cleanly.');
      } catch (e) {
        console.error('[Database] Failed to close SQLite database connection:', e);
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
