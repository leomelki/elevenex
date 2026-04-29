import { Injectable } from '@nestjs/common';
import { execSync } from 'child_process';

@Injectable()
export class AppService {
  readonly gitSha: string;

  constructor() {
    try {
      this.gitSha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    } catch {
      this.gitSha = 'unknown';
    }
  }

  getHello(): string {
    return 'Hello World!';
  }
}
