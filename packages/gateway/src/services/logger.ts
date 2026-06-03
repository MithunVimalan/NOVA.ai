export class SecureLogger {
  private sensitiveKeys = ['password', 'token', 'secret', 'key', 'authorization', 'cvv', 'creditcard', 'passphrase'];

  /**
   * Recursively traverses an object and redacts keys containing sensitive keywords
   */
  private redact(obj: any): any {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) {
      return obj.map(item => this.redact(item));
    }

    const redactedObj: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      const lowerKey = k.toLowerCase();
      const isSensitive = this.sensitiveKeys.some(sk => lowerKey.includes(sk));
      
      if (isSensitive) {
        redactedObj[k] = '[REDACTED]';
      } else {
        redactedObj[k] = this.redact(v);
      }
    }
    return redactedObj;
  }

  public info(message: string, context?: any) {
    const redactedContext = context ? this.redact(context) : '';
    console.log(`[INFO] ${message}`, redactedContext ? JSON.stringify(redactedContext) : '');
  }

  public warn(message: string, context?: any) {
    const redactedContext = context ? this.redact(context) : '';
    console.log(`[WARN] ${message}`, redactedContext ? JSON.stringify(redactedContext) : '');
  }

  public error(message: string, context?: any) {
    const redactedContext = context ? this.redact(context) : '';
    console.log(`[ERROR] ${message}`, redactedContext ? JSON.stringify(redactedContext) : '');
  }
}

let secureLoggerInstance: SecureLogger | null = null;
export function getSecureLogger(): SecureLogger {
  if (!secureLoggerInstance) {
    secureLoggerInstance = new SecureLogger();
  }
  return secureLoggerInstance;
}
