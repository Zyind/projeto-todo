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

  // Issue #3: Testes de paginação e exclusão
  it('lista registros de forma paginada (5 itens por página) e ordenada (issue #3)', () => {
    const db = new Db(':memory:');
    for (let i = 1; i <= 7; i++) {
      db.createRecord(
        {
          title: `Tarefa ${String(i).padStart(2, '0')}`,
          description: `Desc ${i}`,
          category: 'Trabalho',
          priority: i % 2 === 0 ? 'alta' : 'baixa',
          due_date: `2026-11-${String(10 + i).padStart(2, '0')}`,
        },
        `req-bulk-${i}`,
        'web',
      );
    }

    // Página 1 com limite padrão de 5 itens
    const page1 = db.listRecordsPaginated({ page: 1, limit: 5, sort: 'title', order: 'asc' }, 'req-p1', 'web');
    expect(page1.total).toBe(7);
    expect(page1.page).toBe(1);
    expect(page1.limit).toBe(5);
    expect(page1.totalPages).toBe(2);
    expect(page1.items).toHaveLength(5);
    expect(page1.items[0].title).toBe('Tarefa 01');

    // Página 2 com os 2 itens restantes
    const page2 = db.listRecordsPaginated({ page: 2, limit: 5, sort: 'title', order: 'asc' }, 'req-p2', 'web');
    expect(page2.page).toBe(2);
    expect(page2.items).toHaveLength(2);
    expect(page2.items[0].title).toBe('Tarefa 06');

    // Ordenação decrescente e campo inválido (fallback para id)
    const fallback = db.listRecordsPaginated({ page: 1, limit: 5, sort: 'campo_inexistente', order: 'desc' }, 'req-fb', 'web');
    expect(fallback.items[0].id).toBeGreaterThan(fallback.items[1].id);

    db.close();
  });

  it('exclui registro existente e registra log na camada db (issue #3)', () => {
    const db = new Db(':memory:');
    const created = db.createRecord(
      {
        title: 'Para excluir',
        description: 'Sera removida',
        category: 'Geral',
        priority: 'baixa',
      },
      'req-del-init',
      'web',
    );

    written = [];
    const success = db.deleteRecord(created.id, 'req-del-1', 'web');
    expect(success).toBe(true);

    const check = db.findRecordById(created.id, 'req-check', 'web');
    expect(check).toBeUndefined();

    const delLog = logs().find((l) => l.operation === 'delete_record');
    expect(delLog).toMatchObject({
      layer: 'db',
      client: 'web',
      status: 'success',
      request_id: 'req-del-1',
    });
    db.close();
  });

  it('retorna false e registra WARN ao tentar excluir registro inexistente (issue #3)', () => {
    const db = new Db(':memory:');
    written = [];
    const success = db.deleteRecord(8888, 'req-del-fail', 'web');
    expect(success).toBe(false);

    const delLog = logs().find((l) => l.operation === 'delete_record');
    expect(delLog).toMatchObject({
      layer: 'db',
      status: 'error',
      level: 'WARN',
      request_id: 'req-del-fail',
    });
    db.close();
  });
});

describe('Db - searchRecords (issue #4)', () => {
  function seeded(): Db {
    const db = new Db(':memory:');
    const base = { description: 'Descrição' };
    db.createRecord({ ...base, title: 'Relatório mensal', category: 'Trabalho', priority: 'alta', due_date: '2026-12-05' }, 's1', 'web');
    db.createRecord({ ...base, title: 'Estudar Git', category: 'Estudo', priority: 'media', due_date: '2026-12-20' }, 's2', 'web');
    db.createRecord({ ...base, title: 'Relatório anual', category: 'Estudo', priority: 'alta', due_date: null }, 's3', 'web');
    db.createRecord({ ...base, title: '50% feito', description: 'ver item_1', category: 'Geral', priority: 'baixa' }, 's4', 'web');
    written = [];
    return db;
  }
  const titles = (r: { items: { title: string }[] }) => r.items.map((i) => i.title);
  const page = { page: 1, limit: 5, sort: 'id', order: 'asc' };

  it('sem filtros devolve tudo, paginado, e registra o log da camada db com o request_id', () => {
    const db = seeded();
    const result = db.searchRecords({}, { ...page, limit: 2 }, 'req-s1', 'web');
    expect(result).toMatchObject({ total: 4, page: 1, limit: 2, totalPages: 2 });
    expect(titles(result)).toEqual(['Relatório mensal', 'Estudar Git']);
    expect(logs()[0]).toMatchObject({
      level: 'INFO',
      layer: 'db',
      client: 'web',
      operation: 'search_records',
      status: 'success',
      request_id: 'req-s1',
    });
    expect(logs()[0].message).toContain('filtros: nenhum');
    db.close();
  });

  it('filtra por texto, categoria e prioridade, também combinados', () => {
    const db = seeded();
    expect(titles(db.searchRecords({ q: 'relatório' }, page, 'r', 'web'))).toEqual(['Relatório mensal', 'Relatório anual']);
    expect(titles(db.searchRecords({ category: 'estudo' }, page, 'r', 'web'))).toEqual(['Estudar Git', 'Relatório anual']);
    expect(titles(db.searchRecords({ priority: 'alta' }, page, 'r', 'web'))).toEqual(['Relatório mensal', 'Relatório anual']);
    const combined = db.searchRecords({ q: 'relatório', category: 'Estudo', priority: 'alta' }, page, 'r', 'web');
    expect(titles(combined)).toEqual(['Relatório anual']);
    expect(logs().pop().message).toContain('filtros: q, category, priority');
    db.close();
  });

  it('filtra por intervalo de prazo e exclui registros sem prazo', () => {
    const db = seeded();
    expect(titles(db.searchRecords({ due_from: '2026-12-10' }, page, 'r', 'web'))).toEqual(['Estudar Git']);
    expect(titles(db.searchRecords({ due_to: '2026-12-10' }, page, 'r', 'web'))).toEqual(['Relatório mensal']);
    const both = db.searchRecords({ due_from: '2026-12-01', due_to: '2026-12-31' }, page, 'r', 'web');
    expect(titles(both)).toEqual(['Relatório mensal', 'Estudar Git']);
    db.close();
  });

  it('trata %, _ e \\ como texto comum', () => {
    const db = seeded();
    expect(titles(db.searchRecords({ q: '50%' }, page, 'r', 'web'))).toEqual(['50% feito']);
    expect(titles(db.searchRecords({ q: 'item_1' }, page, 'r', 'web'))).toEqual(['50% feito']);
    expect(db.searchRecords({ q: 'item_2' }, page, 'r', 'web').total).toBe(0);
    expect(db.searchRecords({ q: '%' }, page, 'r', 'web').total).toBe(1);
    expect(db.searchRecords({ q: 'a\\b' }, page, 'r', 'web').total).toBe(0);
    db.close();
  });

  it('não é vulnerável a injeção de SQL nos valores dos filtros', () => {
    const db = seeded();
    expect(db.searchRecords({ q: "' OR 1=1 --" }, page, 'r', 'web').total).toBe(0);
    expect(db.searchRecords({ category: "x' OR '1'='1" }, page, 'r', 'web').total).toBe(0);
    expect(db.searchRecords({}, page, 'r', 'web').total).toBe(4);
    db.close();
  });

  it('ordena, usa o padrão para campo inválido e limita o tamanho da página', () => {
    const db = seeded();
    const desc = db.searchRecords({}, { page: 1, limit: 5, sort: 'title', order: 'desc' }, 'r', 'web');
    expect(titles(desc)).toEqual(['Relatório mensal', 'Relatório anual', 'Estudar Git', '50% feito']);
    const fallback = db.searchRecords({}, { page: 1, limit: 5, sort: 'drop table', order: 'qualquer' }, 'r', 'web');
    expect(titles(fallback)[0]).toBe('50% feito');
    expect(db.searchRecords({}, { limit: 1000 }, 'r', 'web').limit).toBe(100);
    expect(db.searchRecords({}, {}, 'r', 'web')).toMatchObject({ page: 1, limit: 5 });
    db.close();
  });

  it('nunca devolve página além da última nem abaixo da primeira', () => {
    const db = seeded();
    const beyond = db.searchRecords({}, { ...page, limit: 3, page: 99 }, 'r', 'web');
    expect(beyond).toMatchObject({ page: 2, totalPages: 2 });
    expect(beyond.items).toHaveLength(1);
    expect(db.searchRecords({}, { ...page, page: -4 }, 'r', 'web').page).toBe(1);
    const none = db.searchRecords({ q: 'inexistente' }, page, 'r', 'web');
    expect(none).toMatchObject({ items: [], total: 0, page: 1, totalPages: 1 });
    db.close();
  });
});

describe('findCliUser (issue #7)', () => {
  it('encontra o usuário e registra o log da camada db com client cli e o request_id recebido', () => {
    const db = new Db(':memory:');
    db.seedUser('admin', 'segredo123');
    written = [];

    const user = db.findCliUser('admin', 'req-cli-1');
    expect(user?.username).toBe('admin');
    expect(logs()[0]).toMatchObject({
      level: 'INFO',
      layer: 'db',
      client: 'cli',
      operation: 'select_cli_user',
      status: 'success',
      request_id: 'req-cli-1',
      message: 'Usuário da CLI encontrado',
    });
    db.close();
  });

  it('retorna undefined e registra o log quando o usuário não existe', () => {
    const db = new Db(':memory:');
    expect(db.findCliUser('ninguem', 'req-cli-2')).toBeUndefined();
    expect(logs()[0]).toMatchObject({
      client: 'cli',
      request_id: 'req-cli-2',
      message: 'Usuário da CLI não encontrado',
    });
    db.close();
  });
});
