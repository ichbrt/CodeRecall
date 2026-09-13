import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, lstatSync } from 'node:fs';
import path from 'node:path';
import type { AdaptationPlan, ProjectFingerprint, ResultRecord, ReuseRecord } from './domain.js';

export class RepositoryStore {
  private readonly db: DatabaseSync;

  constructor(public readonly directory: string) {
    const absolute = path.resolve(directory);
    let ancestor = path.parse(absolute).root;
    for (const part of absolute.slice(ancestor.length).split(path.sep).filter(Boolean)) {
      ancestor = path.join(ancestor, part);
      try { if (lstatSync(ancestor).isSymbolicLink()) throw new Error('Memory path cannot traverse symbolic links or junctions.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw new Error('Memory directory cannot be a symbolic link.');
    const file = path.join(directory, 'memory.db');
    try { const stat = lstatSync(file); if (stat.isSymbolicLink() || stat.nlink > 1) throw new Error('Memory database must be a regular unlinked file.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.db = new DatabaseSync(file, { timeout: 5000 });
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
    if (version !== 0 && version !== 1) { this.db.close(); throw new Error('Unsupported memory schema version.'); }
    this.db.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS reuses (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS results (id INTEGER PRIMARY KEY, reuse_id TEXT NOT NULL, body TEXT NOT NULL) STRICT;
      PRAGMA user_version = 1;
    `);
    if (process.platform !== 'win32') chmodSync(file, 0o600);
  }

  close(): void { this.db.close(); }

  saveProject(project: ProjectFingerprint): void {
    const previous = this.listProjects().find(item => item.id === project.id);
    if (previous?.snapshot === project.snapshot && !project.verification) project.verification = previous.verification;
    this.db.prepare('INSERT INTO projects VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body').run(project.id, JSON.stringify(project));
  }

  listProjects(): ProjectFingerprint[] {
    return this.db.prepare('SELECT body FROM projects ORDER BY id').all().map(row => JSON.parse(String(row.body)) as ProjectFingerprint);
  }

  project(idOrName: string): ProjectFingerprint {
    const exact = this.listProjects().filter(project => project.id === idOrName || project.name === idOrName);
    if (exact.length !== 1) throw new Error(exact.length ? 'Ambiguous project name; use its ID.' : 'Project not indexed.');
    return exact[0]!;
  }

  savePlan(plan: AdaptationPlan): void { this.db.prepare('INSERT INTO plans VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body').run(plan.id, JSON.stringify(plan)); }
  plan(id: string): AdaptationPlan {
    const row = this.db.prepare('SELECT body FROM plans WHERE id = ?').get(id);
    if (!row) throw new Error('Plan not found; create a plan first.');
    return JSON.parse(String(row.body)) as AdaptationPlan;
  }
  saveReuse(record: ReuseRecord): void { this.db.prepare('INSERT INTO reuses VALUES (?, ?)').run(record.id, JSON.stringify(record)); }
  reuse(id: string): ReuseRecord {
    const row = this.db.prepare('SELECT body FROM reuses WHERE id = ?').get(id);
    if (!row) throw new Error('Reuse record not found in this memory.');
    return JSON.parse(String(row.body)) as ReuseRecord;
  }
  saveResult(record: ResultRecord): void { this.db.prepare('INSERT INTO results (reuse_id, body) VALUES (?, ?)').run(record.reuseId, JSON.stringify(record)); }
  results(reuseId: string): ResultRecord[] { return this.db.prepare('SELECT body FROM results WHERE reuse_id = ? ORDER BY id').all(reuseId).map(row => JSON.parse(String(row.body)) as ResultRecord); }
}
