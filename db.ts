import Database from 'better-sqlite3';
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

export interface LogEvent {
  level: 'INFO' | 'WARN' | 'ERROR';
  layer: 'api' | 'db';
  client: 'web' | 'cli';
  operation: string;
  status: 'success' | 'error';
  request_id: string;
  message: string;
}

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
}

export interface RecordRow {
  id: number;
  title: string;
  description: string;
  category: string;
  priority: string;
  due_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecordInput {
  title: string;
  description: string;
  category: string;
  priority: string;
  due_date?: string | null;
}

/** Escreve um evento de log: uma linha JSON no stdout (visível em `docker compose logs`). */
export function logEvent(event: LogEvent): void {
  process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + '\n');
}

/** Gera o hash da senha com scrypt + salt aleatório (formato `salt:hash`). Nunca guarda a senha em texto puro. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

/** Compara a senha informada com o hash guardado, em tempo constante. */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  const candidate = scryptSync(password, salt, 64);
  return timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

/** Acesso ao SQLite. Todas as consultas SQL da aplicação ficam neste arquivo. */
export class Db {
  private readonly conn: Database.Database;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.conn = new Database(file);
    this.conn.exec(
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        priority TEXT NOT NULL,
        due_date TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,
    );
  }

  /** Cria o usuário inicial se ele ainda não existir. */
  seedUser(username: string, password: string): void {
    const exists = this.conn.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (!exists) {
      this.conn
        .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
        .run(username, hashPassword(password));
    }
    logEvent({
      level: 'INFO',
      layer: 'db',
      client: 'web',
      operation: 'seed_user',
      status: 'success',
      request_id: 'startup',
      message: exists ? 'Usuário inicial já existia' : 'Usuário inicial criado',
    });
  }

  /** Busca um usuário pelo nome (usada no login). Registra o log da camada db com o mesmo request_id da API. */
  findUserByUsername(username: string, requestId: string, client: 'web' | 'cli'): UserRow | undefined {
    const row = this.conn
      .prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
      .get(username) as UserRow | undefined;
    logEvent({
      level: 'INFO',
      layer: 'db',
      client,
      operation: 'select_user',
      status: 'success',
      request_id: requestId,
      message: row ? 'Usuário encontrado' : 'Usuário não encontrado',
    });
    return row;
  }

  /** Insere um novo registro (tarefa) e registra o log na camada db. */
  createRecord(data: RecordInput, requestId: string, client: 'web' | 'cli'): RecordRow {
    const now = new Date().toISOString();
    const dueDate = data.due_date ? String(data.due_date).trim() : null;
    const stmt = this.conn.prepare(
      `INSERT INTO records (title, description, category, priority, due_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const info = stmt.run(
      data.title.trim(),
      data.description.trim(),
      data.category.trim(),
      data.priority.trim(),
      dueDate,
      now,
      now,
    );
    const record = this.conn
      .prepare('SELECT * FROM records WHERE id = ?')
      .get(info.lastInsertRowid) as RecordRow;

    logEvent({
      level: 'INFO',
      layer: 'db',
      client,
      operation: 'insert_record',
      status: 'success',
      request_id: requestId,
      message: `Registro ${record.id} inserido com sucesso`,
    });
    return record;
  }

  /** Atualiza um registro existente e registra o log na camada db. */
  updateRecord(id: number, data: RecordInput, requestId: string, client: 'web' | 'cli'): RecordRow | undefined {
    const existing = this.conn.prepare('SELECT id FROM records WHERE id = ?').get(id);
    if (!existing) {
      logEvent({
        level: 'WARN',
        layer: 'db',
        client,
        operation: 'update_record',
        status: 'error',
        request_id: requestId,
        message: `Registro ${id} não encontrado para atualização`,
      });
      return undefined;
    }

    const now = new Date().toISOString();
    const dueDate = data.due_date ? String(data.due_date).trim() : null;
    this.conn
      .prepare(
        `UPDATE records
         SET title = ?, description = ?, category = ?, priority = ?, due_date = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        data.title.trim(),
        data.description.trim(),
        data.category.trim(),
        data.priority.trim(),
        dueDate,
        now,
        id,
      );

    const updated = this.conn.prepare('SELECT * FROM records WHERE id = ?').get(id) as RecordRow;
    logEvent({
      level: 'INFO',
      layer: 'db',
      client,
      operation: 'update_record',
      status: 'success',
      request_id: requestId,
      message: `Registro ${id} atualizado com sucesso`,
    });
    return updated;
  }

  /** Busca um registro pelo id. */
  findRecordById(id: number, requestId: string, client: 'web' | 'cli'): RecordRow | undefined {
    const row = this.conn.prepare('SELECT * FROM records WHERE id = ?').get(id) as RecordRow | undefined;
    logEvent({
      level: 'INFO',
      layer: 'db',
      client,
      operation: 'select_record',
      status: 'success',
      request_id: requestId,
      message: row ? `Registro ${id} encontrado` : `Registro ${id} não encontrado`,
    });
    return row;
  }

  /** Lista todos os registros ordenados pelos mais recentes. */
  listRecords(requestId: string, client: 'web' | 'cli'): RecordRow[] {
    const rows = this.conn.prepare('SELECT * FROM records ORDER BY id DESC').all() as RecordRow[];
    logEvent({
      level: 'INFO',
      layer: 'db',
      client,
      operation: 'list_records',
      status: 'success',
      request_id: requestId,
      message: `${rows.length} registro(s) retornado(s)`,
    });
    return rows;
  }

  close(): void {
    this.conn.close();
  }
}
