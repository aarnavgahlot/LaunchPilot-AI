import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentRun } from './domain.js'

export interface RunStore { get(id: string): Promise<AgentRun | undefined>; list(): Promise<AgentRun[]>; save(run: AgentRun): Promise<void> }

export class JsonRunStore implements RunStore {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly file: string
  constructor(directory: string) { this.file = join(directory, 'runs.json') }
  private async readAll(): Promise<Record<string, AgentRun>> {
    try { return JSON.parse(await readFile(this.file, 'utf8')) as Record<string, AgentRun> }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
  }
  async get(id: string) { return (await this.readAll())[id] }
  async list() { return Object.values(await this.readAll()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }
  async save(run: AgentRun) {
    const operation = this.queue.then(async () => {
      await mkdir(join(this.file, '..'), { recursive: true })
      const all = await this.readAll()
      all[run.id] = run
      const temp = `${this.file}.${process.pid}.tmp`
      await writeFile(temp, JSON.stringify(all, null, 2), { mode: 0o600 })
      await rename(temp, this.file)
    })
    this.queue = operation.catch(() => undefined)
    await operation
  }
}

export class MemoryRunStore implements RunStore {
  private runs = new Map<string, AgentRun>()
  async get(id: string) { const run = this.runs.get(id); return run ? structuredClone(run) : undefined }
  async list() { return [...this.runs.values()].map(run => structuredClone(run)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }
  async save(run: AgentRun) { this.runs.set(run.id, structuredClone(run)) }
}
