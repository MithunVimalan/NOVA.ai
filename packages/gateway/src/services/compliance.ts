import fs from 'node:fs';
import path from 'node:path';

export class ComplianceChecker {
  /**
   * Verifies that .env is present in the workspace root .gitignore
   */
  public checkGitignoreForEnv(): boolean {
    let currentDir = process.cwd();
    // Climb up to find .gitignore if needed
    while (path.dirname(currentDir) !== currentDir) {
      const gitignorePath = path.join(currentDir, '.gitignore');
      if (fs.existsSync(gitignorePath)) {
        const content = fs.readFileSync(gitignorePath, 'utf-8');
        const lines = content.split('\n').map(l => l.trim());
        return lines.includes('.env') || lines.includes('*.env');
      }
      currentDir = path.dirname(currentDir);
    }
    return false;
  }

  /**
   * Scans code strings for hardcoded secrets like Stripe keys, OAuth client keys, or plain credentials.
   */
  public scanContentForSecrets(content: string): boolean {
    // Basic heuristics for hardcoded API secrets
    const secretPatterns = [
      /sk_live_[0-9a-zA-Z]{20,}/,                      // Stripe live secret key
      /amzn\.mws\.[0-9a-fA-F-]{36}/,                  // Amazon MWS Auth Token
      /daohong_secret_[0-9a-zA-Z]/,
      /mongodb\+srv:\/\/[^:]+:[^@]+@/,                // MongoDB connection string with credentials
      /mysql:\/\/[^:]+:[^@]+@/,                      // MySQL connection string with credentials
      /postgres:\/\/[^:]+:[^@]+@/,                    // PostgreSQL connection string with credentials
      /password\s*=\s*['"][a-zA-Z0-9!@#$%^&*()_+]{8,}['"]/i // Plain-text password assignments
    ];

    for (const pattern of secretPatterns) {
      if (pattern.test(content)) {
        console.warn(`[Compliance Warning] Potential hardcoded credential/secret matched pattern: ${pattern}`);
        return false;
      }
    }
    return true;
  }

  /**
   * Recursively scans the source files for hardcoded secrets
   */
  public scanSourceFiles(dirPath: string): { success: boolean; issuesCount: number } {
    let issuesCount = 0;

    const traverse = (currentDir: string) => {
      const items = fs.readdirSync(currentDir);
      for (const item of items) {
        if (item === 'node_modules' || item === '.git' || item === 'dist') continue;
        const fullPath = path.join(currentDir, item);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          traverse(fullPath);
        } else if (stat.isFile()) {
          const ext = path.extname(item);
          if (['.ts', '.js', '.json'].includes(ext)) {
            const content = fs.readFileSync(fullPath, 'utf-8');
            const passed = this.scanContentForSecrets(content);
            if (!passed) {
              console.error(`[Compliance Failure] Credential pattern triggered in: ${fullPath}`);
              issuesCount++;
            }
          }
        }
      }
    };

    if (fs.existsSync(dirPath)) {
      traverse(dirPath);
    }

    return {
      success: issuesCount === 0,
      issuesCount
    };
  }
}
