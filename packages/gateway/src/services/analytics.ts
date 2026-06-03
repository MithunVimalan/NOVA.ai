import { getSqliteManager, SalesLog } from '@nova/shared';

export interface AnalyticsOverview {
  salesTrends: {
    today: { revenue: number; count: number };
    weekly: { revenue: number; count: number };
    monthly: { revenue: number; count: number };
    yearly: { revenue: number; count: number };
  };
  visitors: {
    totalVisits: number;
    uniqueVisitors: number;
    bounceRate: number;
    avgSessionLength: number;
    newVisitors: number;
    returningVisitors: number;
  };
  products: Array<{
    productId: string;
    views: number;
    conversions: number;
    conversionRate: number;
  }>;
}

/**
 * Computes business intelligence overview statistics from SQLite databases.
 */
export function computeAnalyticsOverview(): AnalyticsOverview {
  const sqliteDb = getSqliteManager();
  
  // 1. Fetch data
  const sales = sqliteDb.getSalesLogs ? sqliteDb.getSalesLogs() : [];
  const visitors = sqliteDb.getVisitorLogs ? sqliteDb.getVisitorLogs() : [];
  
  const now = new Date();
  const oneDayMs = 24 * 60 * 60 * 1000;

  // Initialize revenue trend counters
  let todayRev = 0, todayCount = 0;
  let weekRev = 0, weekCount = 0;
  let monthRev = 0, monthCount = 0;
  let yearRev = 0, yearCount = 0;

  // 2. Compute Sales Trends
  for (const sale of sales) {
    const saleDate = new Date(sale.timestamp);
    const ageMs = now.getTime() - saleDate.getTime();

    // Today (24 hours)
    if (ageMs <= oneDayMs) {
      todayRev += sale.revenue;
      todayCount++;
    }
    // Weekly (7 days)
    if (ageMs <= 7 * oneDayMs) {
      weekRev += sale.revenue;
      weekCount++;
    }
    // Monthly (30 days)
    if (ageMs <= 30 * oneDayMs) {
      monthRev += sale.revenue;
      monthCount++;
    }
    // Yearly (365 days)
    if (ageMs <= 365 * oneDayMs) {
      yearRev += sale.revenue;
      yearCount++;
    }
  }

  // 3. Compute Visitor Metrics
  const totalVisits = visitors.length;
  const sessionsMap: Record<string, typeof visitors> = {};
  
  for (const v of visitors) {
    if (!sessionsMap[v.sessionId]) {
      sessionsMap[v.sessionId] = [];
    }
    sessionsMap[v.sessionId].push(v);
  }

  const uniqueSessionIds = Object.keys(sessionsMap);
  const uniqueVisitors = uniqueSessionIds.length;

  let bouncedSessionsCount = 0;
  let totalSessionDurations = 0;
  let newVisitors = 0;
  let returningVisitors = 0;

  for (const sessionId of uniqueSessionIds) {
    const events = sessionsMap[sessionId];
    
    // Bounce calculation: session has exactly 1 event
    if (events.length === 1) {
      bouncedSessionsCount++;
      newVisitors++;
    } else {
      returningVisitors++;
    }

    // Session duration calculation
    const timestamps = events.map(e => new Date(e.timestamp).getTime());
    const minTime = Math.min(...timestamps);
    const maxTime = Math.max(...timestamps);
    let sessionLengthSec = (maxTime - minTime) / 1000;

    // Fall back to max timeOnPage if timestamps don't span or are identical
    if (sessionLengthSec === 0) {
      const maxTimeOnPage = Math.max(...events.map(e => e.timeOnPage || 0));
      sessionLengthSec = maxTimeOnPage;
    }

    totalSessionDurations += sessionLengthSec;
  }

  const bounceRate = uniqueVisitors > 0 ? Math.round((bouncedSessionsCount / uniqueVisitors) * 100) : 0;
  const avgSessionLength = uniqueVisitors > 0 ? Math.round(totalSessionDurations / uniqueVisitors) : 0;

  // 4. Compute Product Analytics (Product Rankings & Conversions)
  // Extract productId from pageUrl via regex (e.g. /product/prod-123 or /products/prod-123)
  const productViewsMap: Record<string, number> = {};
  const productRegex = /\/products?\/([^/?#]+)/i;

  for (const v of visitors) {
    const match = v.pageUrl.match(productRegex);
    if (match && match[1]) {
      const productId = match[1];
      productViewsMap[productId] = (productViewsMap[productId] || 0) + 1;
    }
  }

  const productConversionsMap: Record<string, number> = {};
  for (const sale of sales) {
    productConversionsMap[sale.productId] = (productConversionsMap[sale.productId] || 0) + 1;
  }

  // Merge products
  const allProductIds = new Set([
    ...Object.keys(productViewsMap),
    ...Object.keys(productConversionsMap)
  ]);

  const productsList = Array.from(allProductIds).map(productId => {
    const views = productViewsMap[productId] || 0;
    const conversions = productConversionsMap[productId] || 0;
    const conversionRate = views > 0 ? Math.round((conversions / views) * 1000) / 10 : 0; // 1 decimal place

    return {
      productId,
      views,
      conversions,
      conversionRate
    };
  });

  // Sort products by conversions descending, then views descending
  productsList.sort((a, b) => b.conversions - a.conversions || b.views - a.views);

  return {
    salesTrends: {
      today: { revenue: todayRev, count: todayCount },
      weekly: { revenue: weekRev, count: weekCount },
      monthly: { revenue: monthRev, count: monthCount },
      yearly: { revenue: yearRev, count: yearCount },
    },
    visitors: {
      totalVisits,
      uniqueVisitors,
      bounceRate,
      avgSessionLength,
      newVisitors,
      returningVisitors,
    },
    products: productsList
  };
}
