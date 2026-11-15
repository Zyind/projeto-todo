import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Db, hashPassword, logEvent, verifyPassword } from '../db';

let written: string[];

beforeEach(() => {
  written = [];
  jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

const logs = () => written.map((line) => JSON.parse(line));

describe('senhas', () => {
  it('gera hash com salt e nunca guarda a senha em texto puro', () => {
    const first = hashPassword('segredo');
    const second = hashPassword('segredo');
    expect(first).not.toContain('segredo');
    expect(first).not.toEqual(second);
  });

  it('verifica a senha correta e rejeita a errada', () => {
    const stored = hashPassword('segredo');
    expect(verifyPassword('segredo', stored)).toBe(true);
    expect(verifyPassword('outra', stored)).toBe(false);
  });
});

describe('logEvent', () => {
  it('escreve uma linha JSON com os campos obrigatórios', () => {
    logEvent({
      level: 'INFO',
      layer: 'api',
      client: 'cli',
      operation: 'create',
      status: 'success',
      request_id: 'req-123',
      message: 'Registro criado',
    });
    expect(written).toHaveLength(1);
    expect(written[0].endsWith('\n')).toBe(true);
    const entry = logs()[0];
    expect(Object.keys(entry)).toEqual([
      'timestamp',
      'level',
      'layer',
      'client',
      'operation',
      'status',
      'request_id',
      'message',
    ]);
    expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
  });
});

describe('Db - Usuários', () => {
  it('cria o usuário inicial uma única vez', () => {
    const db = new Db(':memory:');
    db.seedUser('admin', 'segredo');
    const first = db.findUserByUsername('admin', 'req-1', 'web');
    db.seedUser('admin', 'segredo');
    const second = db.findUserByUsername('admin', 'req-2', 'web');

    expect(first?.id).toBe(second?.id);
    expect(first?.password_hash).not.toContain('segredo');
    const seedMessages = logs()
      .filter((entry) => entry.operation === 'seed_user')
      .map((entry) => entry.message);
    expect(seedMessages).toEqual(['Usuário inicial criado', 'Usuário inicial já existia']);
    db.close();
  });

  it('busca usuário e registra log da camada db com o request_id recebido', () => {
    const db = new Db(':memory:');
    db.seedUser('admin', 'segredo');
    written = [];

    expect(db.findUserByUsername('admin', 'req-abc', 'cli')?.username).toBe('admin');
    expect(db.findUserByUsername('ninguem', 'req-def', 'web')).toBeUndefined();

    const [found, missing] = logs();
    expect(found).toMatchObject({ layer: 'db', client: 'cli', request_id: 'req-abc', message: 'Usuário encontrado' });
    expect(missing).toMatchObject({ layer: 'db', client: 'web', request_id: 'req-def', message: 'Usuário não encontrado' });
    db.close();
  });

  it('cria a pasta do arquivo SQLite quando necessário', () => {
    const dir = mkdtempSync(join(tmpdir(), 'todo-'));
    const file = join(dir, 'nova-pasta', 'app.db');
    const db = new Db(file);
    expect(existsSync(file)).toBe(true);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('Db - Registros (Tarefas)', () => {
  it('cria registro com data de vencimento e registra log db correlacionado', () => {
    const db = new Db(':memory:');
    const record = db.createRecord(
      {
        title: 'Estudar Git',
        description: 'Ler o livro Learning Git',
        category: 'Estudo',
        priority: 'alta',
        due_date: '2026-11-20',
      },
      'req-insert-1',
      'web',
    );

    expect(record.id).toBeDefined();
    expect(record.title).toBe('Estudar Git');
    expect(record.due_date).toBe('2026-11-20');
    expect(record.created_at).toBeDefined();
    expect(record.updated_at).toBeDefined();

    const dbLog = logs().find((l) => l.operation === 'insert_record');
    expect(dbLog).toMatchObject({
      layer: 'db',
      client: 'web',
      status: 'success',
      request_id: 'req-insert-1',
    });
    db.close();
  });

  it('cria registro sem data de vencimento (null)', () => {
    const db = new Db(':memory:');
    const record = db.createRecord(
      {
        title: 'Comprar pão',
        description: 'Padaria da esquina',
        category: 'Pessoal',
        priority: 'baixa',
      },
      'req-insert-2',
      'web',
    );
    expect(record.due_date).toBeNull();
    db.close();
  });

  it('atualiza registro existente e registra log de sucesso', () => {
    const db = new Db(':memory:');
    const created = db.createRecord(
      {
        title: 'Tarefa original',
        description: 'Desc original',
        category: 'Trabalho',
        priority: 'media',
      },
      'req-1',
      'web',
    );

    written = [];
    const updated = db.updateRecord(
      created.id,
      {
        title: 'Tarefa modificada',
        description: 'Desc atualizada',
        category: 'Projetos',
        priority: 'alta',
        due_date: '2026-12-01',
      },
      'req-upd-1',
      'web',
    );

    expect(updated).toBeDefined();
    expect(updated?.title).toBe('Tarefa modificada');
    expect(updated?.category).toBe('Projetos');
    expect(updated?.due_date).toBe('2026-12-01');

    const updLog = logs().find((l) => l.operation === 'update_record');
    expect(updLog).toMatchObject({
      layer: 'db',
      client: 'web',
      status: 'success',
      request_id: 'req-upd-1',
    });
    db.close();
  });

  it('retorna undefined e registra WARN ao tentar atualizar registro inexistente', () => {
    const db = new Db(':memory:');
    const res = db.updateRecord(
      999,
      {
        title: 'Não existe',
        description: 'Desc',
        category: 'Outro',
        priority: 'baixa',
      },
      'req-upd-fail',
      'web',
    );

    expect(res).toBeUndefined();
    const failLog = logs().find((l) => l.operation === 'update_record');
    expect(failLog).toMatchObject({
      layer: 'db',
      status: 'error',
      level: 'WARN',
      request_id: 'req-upd-fail',
    });
    db.close();
  });

  it('busca registro por ID (existente e inexistente)', () => {
    const db = new Db(':memory:');
    const created = db.createRecord(
      {
        title: 'Busca teste',
        description: 'Desc teste',
        category: 'Geral',
        priority: 'media',
      },
      'req-find',
      'web',
    );

    const found = db.findRecordById(created.id, 'req-found', 'web');
    expect(found?.title).toBe('Busca teste');

    const notFound = db.findRecordById(9999, 'req-notfound', 'web');
    expect(notFound).toBeUndefined();
    db.close();
  });

  it('lista registros ordenados pelo mais recente', () => {
    const db = new Db(':memory:');
    db.createRecord({ title: 'A', description: 'Desc A', category: 'C', priority: 'baixa' }, 'r1', 'web');
    db.createRecord({ title: 'B', description: 'Desc B', category: 'C', priority: 'alta' }, 'r2', 'web');

    const list = db.listRecords('req-list', 'web');
    expect(list.length).toBe(2);
    expect(list[0].title).toBe('B');
    expect(list[1].title).toBe('A');
    db.close();
  });
});
