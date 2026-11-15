import type { Project } from "@marz/format";
import type { Command } from "./commands";

const MAX_STEPS = 200;

export class History {
  private past: Project[] = [];
  private future: Project[] = [];
  private listeners = new Set<() => void>();
  current: Project;

  constructor(initial: Project) {
    this.current = initial;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  apply(command: Command): void {
    const next = command(this.current);
    if (next === this.current) return; // no-op: no history entry
    this.past.push(this.current);
    if (this.past.length > MAX_STEPS) this.past.shift();
    this.future = [];
    this.current = next;
    this.emit();
  }

  undo(): void {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.current);
    this.current = prev;
    this.emit();
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.current);
    this.current = next;
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
