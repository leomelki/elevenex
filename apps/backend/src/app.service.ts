import { Injectable } from '@nestjs/common';
import { GIT_SHA } from './generated/git-sha';

@Injectable()
export class AppService {
  readonly gitSha: string = GIT_SHA;

  getHello(): string {
    return 'Hello World!';
  }
}
