# To-Do List (Web + CLI)

Projeto da avaliação prática de Git e GitHub. Lista de tarefas com Web (React), API (NestJS) e banco (SQLite), tudo rodando exclusivamente por **Docker Compose**.

**Pré-requisitos no host:** apenas Docker e Docker Compose, além de navegador e terminal.

## Arquivos de produção

| Arquivo | Responsabilidade |
|---|---|
| `index.html` | Toda a Web (HTML, CSS e React via CDN embutidos) |
| `api.ts` | API NestJS: endpoints, autenticação e logs da API |
| `db.ts` | Acesso ao SQLite e logs da camada de banco |
| `cli.ts` | CLI (chega na issue #7) |
| `README.md` | Execução e documentação de cada issue |

---

## Issue #1: Estrutura Web (início, login, logs e testes)

### Como iniciar a Web

```bash
docker compose up --build
```

Quando os logs mostrarem `API escutando na porta 3000`, abra **http://localhost:3000** no navegador.

Para parar: `Ctrl+C` (ou `docker compose down`).

Os dados ficam no volume `db-data`; para zerar tudo use:

```bash
docker compose down -v
```

### Usuário inicial e configuração

Existe um único usuário inicial, criado automaticamente na primeira execução. Ele é configurado por variáveis de ambiente (sem senha real no repositório):

| Variável | Padrão (só desenvolvimento) | Para que serve |
|---|---|---|
| `APP_USER` | `admin` | Nome do usuário inicial |
| `APP_PASSWORD` | `admin123` | Senha do usuário inicial (guardada com hash scrypt + salt) |
| `TOKEN_SECRET` | valor de exemplo no compose | Segredo que assina os tokens de login |

Para trocar, copie `.env.example` para `.env`, edite e suba de novo:

```bash
cp .env.example .env
docker compose up --build
```

Se o volume já existe, o usuário não é recriado. Use `docker compose down -v` para começar do zero.

### Como fazer login

**Pela tela:** abra http://localhost:3000, informe usuário e senha e clique em **Entrar**. Credenciais erradas mostram uma mensagem de erro (a API responde HTTP 401).

**Pela API:**

```bash
# healthcheck (público)
curl http://localhost:3000/api/web/health

# login: devolve {"token": "...", "username": "admin"}
curl -X POST http://localhost:3000/api/web/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'

# rota protegida: exige o token; sem ele (ou inválido) responde 401
curl http://localhost:3000/api/web/me \
  -H "Authorization: Bearer TOKEN"
```

---

## Issue #2: Cadastro e Edição de Tarefas (Web)

Nesta etapa foi implementado o cadastro e edição de tarefas (records) persistidos no SQLite com validação de campos e mensagens de erro na interface e na API.

### Campos do Formulário (5 campos, 4 obrigatórios)

| Campo | Tipo | Validação / Regras | Obrigatório |
|---|---|---|:---:|
| `title` | Texto | Entre 3 e 100 caracteres | **Sim** |
| `description` | Texto longo | Entre 3 e 500 caracteres | **Sim** |
| `category` | Seleção/Texto | Entre 2 e 50 caracteres (Ex: Trabalho, Estudo, Pessoal, Projetos, Geral) | **Sim** |
| `priority` | Seleção | Valores permitidos: `baixa`, `media` ou `alta` | **Sim** |
| `due_date` | Data | Formato `AAAA-MM-DD` válido | Não |

### Validações e Tratamento de Erros

- **Campos obrigatórios ou inválidos:** a API rejeita requisições com código **HTTP 400 (Bad Request)** e retorna um objeto contendo a lista de erros em `errors`:
  ```json
  {
    "message": "Dados inválidos",
    "errors": [
      "Título deve ter entre 3 e 100 caracteres",
      "Prioridade deve ser baixa, media ou alta"
    ]
  }
  ```
- **Na Web (`index.html`):** formulário valida antes do envio e exibe um alerta destacado com a lista de correções necessárias.
- **Autenticação:** todas as operações de cadastro e edição exigem token Bearer válido, respondendo **HTTP 401** caso contrário.
- **Registro não encontrado:** edição em ID inexistente responde **HTTP 404 (Not Found)**.

### Endpoints da Issue #2

| Método | Rota | Autenticação | Descrição |
|---|---|---|---|
| POST | `/api/web/records` | Bearer token | Cadastra uma nova tarefa (retorna HTTP 201) |
| PUT | `/api/web/records/{id}` | Bearer token | Atualiza todos os dados de uma tarefa existente (retorna HTTP 200) |
| GET | `/api/web/records/{id}` | Bearer token | Consulta uma tarefa específica pelo identificador (retorna HTTP 200) |
| GET | `/api/web/records` | Bearer token | Lista as tarefas cadastradas (retorna HTTP 200) |

### Exemplos via cURL

```bash
# 1. Obter o token de autenticação
TOKEN=$(curl -s -X POST http://localhost:3000/api/web/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' | grep -o '"token":"[^"]*' | cut -d'"' -f4)

# 2. Criar uma nova tarefa (POST /api/web/records)
curl -X POST http://localhost:3000/api/web/records \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "title": "Preparar apresentação",
    "description": "Gravar vídeo com os ciclos de integração e worktrees",
    "category": "Estudo",
    "priority": "alta",
    "due_date": "2026-11-20"
  }'

# 3. Editar a tarefa criada (PUT /api/web/records/1)
curl -X PUT http://localhost:3000/api/web/records/1 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "title": "Preparar apresentação do vídeo",
    "description": "Revisar roteiro e gravar apresentação",
    "category": "Projetos",
    "priority": "media",
    "due_date": "2026-11-22"
  }'

# 4. Exemplo de rejeição por validação (HTTP 400)
curl -X POST http://localhost:3000/api/web/records \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"title": "ab"}'
```

---

## Logs e Correlação

Cada operação gera **uma linha JSON por evento** no stdout, uma na camada `api` e outra na camada `db` (quando acessa o banco), com o **mesmo `request_id`**:

```bash
docker compose logs app
docker compose logs -f app
docker compose logs --no-log-prefix app | grep -E '"operation":"(create_record|insert_record|update_record)"'
```

Campos: `timestamp` (ISO 8601 UTC), `level` (`INFO`/`WARN`/`ERROR`), `layer` (`api`/`db`), `client` (`web`/`cli`), `operation`, `status` (`success`/`error`), `request_id` e `message`.

Exemplo de logs de criação correlacionados:

```json
{"timestamp":"2026-11-14T21:30:00.000Z","level":"INFO","layer":"db","client":"web","operation":"insert_record","status":"success","request_id":"550e8400...","message":"Registro 1 inserido com sucesso"}
{"timestamp":"2026-11-14T21:30:00.015Z","level":"INFO","layer":"api","client":"web","operation":"create_record","status":"success","request_id":"550e8400...","message":"Registro 1 criado com sucesso"}
```

---

## Testes e Cobertura de Código

Execução integral via contêiner Docker:

```bash
docker compose run --rm test
```

Roda o Jest dentro do contêiner e afere a cobertura. A execução **exige 100% de cobertura de linhas** nos arquivos de produção existentes (`api.ts` e `db.ts`).

---

## Estrutura de Apoio

`Dockerfile`, `docker-compose.yml`, `package.json`, `tsconfig.json`, `jest.config.js`, `tests/*.spec.ts`, `.gitignore`, `.dockerignore`, `.env.example` e `.github/PULL_REQUEST_TEMPLATE.md` são arquivos auxiliares (infraestrutura, configuração, testes e template de PR).
