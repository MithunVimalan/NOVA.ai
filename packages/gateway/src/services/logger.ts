import { createSingleton } from '@nova/shared';

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

  private log(level: 'INFO' | 'WARN' | 'ERROR', message: string, context?: any) {
    const redactedContext = context ? this.redact(context) : '';
    console.log(`[${level}] ${message}`, redactedContext ? JSON.stringify(redactedContext) : '');
  }

  public info(message: string, context?: any) {
    this.log('INFO', message, context);
  }

  public warn(message: string, context?: any) {
    this.log('WARN', message, context);
  }

  public error(message: string, context?: any) {
    this.log('ERROR', message, context);
  }
}

export const getSecureLogger = createSingleton(() => new SecureLogger());
