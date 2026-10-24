import type { ProjectHue, ProjectMark } from '../tasks/task.models';
import { PROJECT_HUES, type ProjectAppearance } from './project.models';

export function projectInitials(name: string): string {
  const words = name.replace(/[^a-z0-9]+/gi, ' ').trim().split(' ');
  const first = words[0];
  return first ? (first[0]! + (words[1]?.[0] ?? first[1] ?? '')).toUpperCase() : '';
}
export function projectHue(name: string): ProjectHue {
  let hash = 0;
  const text = name || 'project';
  // The supplied design hashes UTF-16 code units, including both surrogate halves.
  for (let index = 0; index < text.length; index++) hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  return PROJECT_HUES[hash % PROJECT_HUES.length]!;
}
export function projectFace(face: ProjectAppearance): ProjectMark {
  return {
    name: face.name || 'New project',
    hue: face.hue || projectHue(face.name),
    ...(face.look === 'emoji' ? { emoji: face.emoji } : face.look === 'icon' ? { icon: face.icon } : { initials: projectInitials(face.name) }),
  };
}
export function folderName(path: string): string {
  return path.replace(/\.git$/, '').replace(/\/+$/, '').split(/[/:]/).pop() || path;
}
