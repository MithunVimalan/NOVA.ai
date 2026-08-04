import path from 'node:path';
import { loadConfig } from '../config.js';
import { ensureDir, readJsonFile, writeJsonFile } from '../utils/fs.js';
import { createSingleton } from '../utils/singleton.js';

const LOG_LABEL = '[Database]';

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
    this.memoryPath = ensureDir(config.paths.memory);
    this.dbPath = path.join(this.memoryPath, 'nova.db');

    this.initializeDb();
  }

  /**
   * Runs a SQLite statement, logging and returning the fallback value if the
   * driver throws.
   */
  private run<T>(operation: string, action: () => T, fallback: T): T {
    try {
      return action();
    } catch (e) {
      console.error(`${LOG_LABEL} ${operation} failed:`, e);
      return fallback;
    }
  }

  private static mapTenantRow(row: any): Tenant {
    return {
      id: row.id,
      name: row.name,
      telegramEnabled: row.telegram_enabled,
      telegramToken: row.telegram_token,
      whatsappEnabled: row.whatsapp_enabled,
      whatsappToken: row.whatsapp_token,
      stripeStatus: row.stripe_status,
    };
  }

  private initializeDb() {
    try {
      // Attempt to load better-sqlite3 dynamically
      const Database = require('better-sqlite3');
      this.dbInstance = new Database(this.dbPath);
      this.dbInstance.pragma('journal_mode = WAL');
      this.setupTables();
      console.log(`${LOG_LABEL} Initialized SQLite at ${this.dbPath} (WAL Mode enabled)`);
    } catch (e) {
      this.isFallback = true;
      this.dbPath = path.join(this.memoryPath, 'nova_db_fallback.json');
      console.warn(`${LOG_LABEL} Native SQLite not available. Falling back to local JSON: ${this.dbPath}`);
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
    const stored = readJsonFile<Partial<typeof this.cache> | null>(this.dbPath, null, LOG_LABEL);
    if (!stored) {
      this.saveFallbackData();
      return;
    }

    this.cache = {
      facts: stored.facts ?? {},
      visitors: stored.visitors ?? [],
      leads: stored.leads ?? [],
      tenants: stored.tenants ?? [],
      sales: stored.sales ?? [],
    };
  }

  private saveFallbackData() {
    writeJsonFile(this.dbPath, this.cache, LOG_LABEL);
  }

  // PROFILE FACTS OPERATIONS
  public getFact(key: string): string | null {
    if (this.isFallback) {
      return this.cache.facts[key]?.value || null;
    }
    return this.run('getFact', () => {
      const row = this.dbInstance.prepare('SELECT value FROM facts WHERE key = ?').get(key);
      return row ? row.value : null;
    }, null);
  }

  public setFact(key: string, value: string): void {
    const now = new Date().toISOString();
    if (this.isFallback) {
      this.cache.facts[key] = { key, value, updatedAt: now };
      this.saveFallbackData();
      return;
    }
    this.run('setFact', () => {
      this.dbInstance.prepare(`
        INSERT INTO facts (key, value, updated_at) 
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
      `).run(key, value, now);
    }, undefined);
  }

  public getAllFacts(): Record<string, string> {
    const result: Record<string, string> = {};
    if (this.isFallback) {
      for (const [k, f] of Object.entries(this.cache.facts)) {
        result[k] = f.value;
      }
      return result;
    }
    return this.run('getAllFacts', () => {
      const rows = this.dbInstance.prepare('SELECT key, value FROM facts').all() as { key: string; value: string }[];
      for (const row of rows) {
        result[row.key] = row.value;
      }
      return result;
    }, result);
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
      return;
    }
    this.run('logVisitorEvent', () => {
      this.dbInstance.prepare(`
        INSERT INTO visitors (session_id, page_url, referrer, scroll_depth, time_on_page, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(event.sessionId, event.pageUrl, event.referrer, event.scrollDepth, event.timeOnPage, timestamp);
    }, undefined);
  }

  public getVisitorLogs(): VisitorEvent[] {
    if (this.isFallback) {
      return [...this.cache.visitors].reverse();
    }
    return this.run<VisitorEvent[]>(
      'getVisitorLogs',
      () => this.dbInstance.prepare('SELECT * FROM visitors ORDER BY id DESC').all() as VisitorEvent[],
      []
    );
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
      return;
    }
    this.run('addLead', () => {
      this.dbInstance.prepare(`
        INSERT INTO leads (session_id, name, email, captured_at)
        VALUES (?, ?, ?, ?)
      `).run(lead.sessionId, lead.name, lead.email, capturedAt);
    }, undefined);
  }

  public getLeads(): Lead[] {
    if (this.isFallback) {
      return [...this.cache.leads].reverse();
    }
    return this.run<Lead[]>(
      'getLeads',
      () => this.dbInstance.prepare('SELECT * FROM leads ORDER BY id DESC').all() as Lead[],
      []
    );
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
      return;
    }
    this.run('addTenant', () => {
      this.dbInstance.prepare(`
        INSERT INTO tenants (id, name, telegram_enabled, telegram_token, whatsapp_enabled, whatsapp_token, stripe_status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET 
          name=excluded.name,
          telegram_enabled=excluded.telegram_enabled,
          telegram_token=excluded.telegram_token,
          whatsapp_enabled=excluded.whatsapp_enabled,
          whatsapp_token=excluded.whatsapp_token,
          stripe_status=excluded.stripe_status
      `).run(
        tenant.id,
        tenant.name,
        tenant.telegramEnabled,
        tenant.telegramToken,
        tenant.whatsappEnabled,
        tenant.whatsappToken,
        tenant.stripeStatus
      );
    }, undefined);
  }

  public getTenant(id: string): Tenant | null {
    if (this.isFallback) {
      this.cache.tenants = this.cache.tenants || [];
      return this.cache.tenants.find(t => t.id === id) || null;
    }
    return this.run<Tenant | null>('getTenant', () => {
      const row = this.dbInstance.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
      return row ? SqliteManager.mapTenantRow(row) : null;
    }, null);
  }

  public getAllTenants(): Tenant[] {
    if (this.isFallback) {
      return this.cache.tenants || [];
    }
    return this.run<Tenant[]>('getAllTenants', () => {
      const rows = this.dbInstance.prepare('SELECT * FROM tenants').all() as any[];
      return rows.map(SqliteManager.mapTenantRow);
    }, []);
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
      return;
    }
    this.run('logSale', () => {
      this.dbInstance.prepare(`
        INSERT INTO sales_logs (product_id, revenue, customer, timestamp)
        VALUES (?, ?, ?, ?)
      `).run(sale.productId, sale.revenue, sale.customer, timestamp);
    }, undefined);
  }

  public getSalesLogs(): SalesLog[] {
    if (this.isFallback) {
      return [...(this.cache.sales || [])].reverse();
    }
    return this.run<SalesLog[]>('getSalesLogs', () => {
      const rows = this.dbInstance.prepare('SELECT * FROM sales_logs ORDER BY timestamp DESC').all() as any[];
      return rows.map(r => ({
        id: r.id,
        productId: r.product_id,
        revenue: r.revenue,
        customer: r.customer,
        timestamp: r.timestamp,
      }));
    }, []);
  }

  public close(): void {
    if (!this.isFallback && this.dbInstance) {
      this.run('close', () => {
        this.dbInstance.close();
        console.log(`${LOG_LABEL} SQLite database connection closed cleanly.`);
      }, undefined);
    }
  }
}

// Single instance exports
export const getSqliteManager = createSingleton(() => new SqliteManager());
