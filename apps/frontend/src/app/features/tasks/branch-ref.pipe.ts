import { Pipe, PipeTransform } from '@angular/core';

@Pipe({ name: 'branchRef' })
export class BranchRefPipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    return (value ?? '').replace(/^refs\/(heads|remotes)\//, '');
  }
}
