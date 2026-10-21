import { createServer as createHttpServer } from 'node:http';
import { database, id, now, passwordHash, passwordVerify, signToken, tokenUser, bodyJson, json, apiServer, string, email, assert, ApiError } from './lib.js';

const VALID_STATUS = ['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE'];
const VALID_PRIORITY = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
export function createApp({ dbPath = process.env.DB_PATH || './data/flowboard.sqlite', secret = process.env.TOKEN_SECRET || 'local-dev-secret-change-for-production' } = {}) {
  const db = database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'USER');
    CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS members(workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE, user_id TEXT REFERENCES users(id), role TEXT CHECK(role IN ('OWNER','MEMBER')) NOT NULL, PRIMARY KEY(workspace_id,user_id));
    CREATE TABLE IF NOT EXISTS boards(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, priority TEXT NOT NULL, assignee_id TEXT REFERENCES users(id), created_by TEXT NOT NULL REFERENCES users(id), version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS activity(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, actor_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_boards_workspace ON boards(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_board_status ON tasks(board_id,status);
    CREATE INDEX IF NOT EXISTS idx_activity_workspace ON activity(workspace_id,created_at);
  `);
  const emit = (wid, uid, action, detail) => db.prepare('INSERT INTO activity VALUES (?,?,?,?,?,?)').run(id(), wid, uid, action, detail, now());
  function membership(wid, user, requireOwner = false) {
    const member = db.prepare('SELECT role FROM members WHERE workspace_id=? AND user_id=?').get(wid, user.id);
    assert(member, 403, 'Workspace access denied');
    if (requireOwner) assert(member.role === 'OWNER', 403, 'Workspace owner required');
    return member;
  }
  function boardAccess(boardId, user) {
    const b = db.prepare('SELECT * FROM boards WHERE id=?').get(boardId);
    assert(b, 404, 'Board not found'); membership(b.workspace_id, user); return b;
  }
  async function handler(req, res, path) {
    const m = req.method;
    if (m === 'GET' && path === '/api/health') return json(res, 200, { status: 'ok', service: 'flowboard' });
    if (m === 'POST' && path === '/api/auth/register') {
      const input = await bodyJson(req); const user = { id: id(), name: string(input.name, 'Name', 80), email: email(input.email), role: 'USER' };
      assert(!db.prepare('SELECT id FROM users WHERE email=?').get(user.email), 409, 'Email already registered');
      db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(user.id, user.name, user.email, passwordHash(input.password), user.role);
      return json(res, 201, { user, token: signToken(user, secret) });
    }
    if (m === 'POST' && path === '/api/auth/login') {
      const input = await bodyJson(req); const found = db.prepare('SELECT * FROM users WHERE email=?').get(email(input.email));
      assert(found && passwordVerify(input.password, found.password_hash), 401, 'Invalid credentials');
      const { password_hash, ...user } = found; return json(res, 200, { user, token: signToken(user, secret) });
    }
    const user = tokenUser(req, db, secret);
    if (m === 'GET' && path === '/api/me') return json(res, 200, { user });
    if (m === 'GET' && path === '/api/workspaces') {
      return json(res, 200, { workspaces: db.prepare(`SELECT w.*,m.role AS member_role FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE m.user_id=? ORDER BY w.created_at DESC`).all(user.id) });
    }
    if (m === 'POST' && path === '/api/workspaces') {
      const input = await bodyJson(req); const wid = id();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO workspaces VALUES (?,?,?,?)').run(wid, string(input.name,'Workspace name'), user.id, now());
        db.prepare('INSERT INTO members VALUES (?,?,?)').run(wid, user.id, 'OWNER');
        db.prepare('INSERT INTO boards VALUES (?,?,?)').run(id(), wid, 'Sprint board');
        emit(wid, user.id, 'WORKSPACE_CREATED', input.name); db.exec('COMMIT');
      } catch(e) { db.exec('ROLLBACK'); throw e; }
      return json(res, 201, { id: wid });
    }
    let match;
    if ((match = /^\/api\/workspaces\/([^/]+)\/members$/.exec(path))) {
      const wid = match[1]; membership(wid, user, m === 'POST');
      if (m === 'GET') return json(res, 200, { members: db.prepare('SELECT u.id,u.name,u.email,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=?').all(wid) });
      if (m === 'POST') {
        const input = await bodyJson(req); const invitee = db.prepare('SELECT id FROM users WHERE email=?').get(email(input.email));
        assert(invitee, 404, 'User must sign up before invitation');
        db.prepare(`INSERT INTO members(workspace_id,user_id,role) VALUES (?,?,'MEMBER') ON CONFLICT(workspace_id,user_id) DO NOTHING`).run(wid, invitee.id);
        emit(wid, user.id, 'MEMBER_ADDED', input.email); return json(res, 201, { added: true });
      }
    }
    if ((match = /^\/api\/workspaces\/([^/]+)\/boards$/.exec(path))) {
      const wid = match[1]; membership(wid, user);
      if (m === 'GET') return json(res, 200, { boards: db.prepare('SELECT * FROM boards WHERE workspace_id=?').all(wid) });
      if (m === 'POST') {
        const input = await bodyJson(req); const b = { id: id(), workspace_id: wid, name: string(input.name,'Board name') };
        db.prepare('INSERT INTO boards VALUES (?,?,?)').run(b.id, b.workspace_id, b.name);
        emit(wid, user.id, 'BOARD_CREATED', b.name); return json(res, 201, { board: b });
      }
    }
    if ((match = /^\/api\/boards\/([^/]+)\/tasks$/.exec(path))) {
      const board = boardAccess(match[1], user);
      if (m === 'GET') return json(res, 200, { tasks: db.prepare('SELECT t.*,u.name AS assignee_name FROM tasks t LEFT JOIN users u ON t.assignee_id=u.id WHERE board_id=? ORDER BY created_at DESC').all(board.id) });
      if (m === 'POST') {
        const input = await bodyJson(req); const status = input.status || 'TODO'; const priority = input.priority || 'MEDIUM';
        assert(VALID_STATUS.includes(status) && VALID_PRIORITY.includes(priority), 400, 'Invalid status or priority');
        if (input.assignee_id) assert(db.prepare('SELECT 1 FROM members WHERE workspace_id=? AND user_id=?').get(board.workspace_id,input.assignee_id), 400, 'Assignee is not a workspace member');
        const task = { id: id(), board_id: board.id, title: string(input.title, 'Task title', 160), description: String(input.description || '').slice(0,2000), status, priority, assignee_id: input.assignee_id || null, created_by: user.id, version: 1, created_at: now(), updated_at: now() };
        db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(task));
        emit(board.workspace_id,user.id,'TASK_CREATED',task.title); return json(res, 201, { task });
      }
    }
    if ((match = /^\/api\/tasks\/([^/]+)$/.exec(path)) && m === 'PATCH') {
      const old = db.prepare('SELECT * FROM tasks WHERE id=?').get(match[1]); assert(old, 404, 'Task not found');
      const board = boardAccess(old.board_id,user); const input=await bodyJson(req);
      assert(Number.isInteger(input.version),400,'Version is required for optimistic locking');
      assert(input.version === old.version,409,'Task changed; refresh and retry');
      const next={ title:input.title === undefined?old.title:string(input.title,'Task title',160), description:input.description === undefined?old.description:String(input.description).slice(0,2000), status:input.status ?? old.status, priority:input.priority ?? old.priority, assignee_id:input.assignee_id===undefined?old.assignee_id:input.assignee_id };
      assert(VALID_STATUS.includes(next.status) && VALID_PRIORITY.includes(next.priority),400,'Invalid status or priority');
      if(next.assignee_id) assert(db.prepare('SELECT 1 FROM members WHERE workspace_id=? AND user_id=?').get(board.workspace_id,next.assignee_id),400,'Assignee is not a workspace member');
      const result=db.prepare('UPDATE tasks SET title=?,description=?,status=?,priority=?,assignee_id=?,updated_at=?,version=version+1 WHERE id=? AND version=?').run(next.title,next.description,next.status,next.priority,next.assignee_id,now(),old.id,input.version);
      assert(result.changes===1,409,'Task changed; refresh and retry');
      emit(board.workspace_id,user.id,'TASK_UPDATED',`${old.title}: ${old.status} → ${next.status}`);
      return json(res,200,{ task:db.prepare('SELECT * FROM tasks WHERE id=?').get(old.id) });
    }
    if ((match = /^\/api\/workspaces\/([^/]+)\/(activity|metrics)$/.exec(path)) && m === 'GET') {
      const wid=match[1]; membership(wid,user);
      if(match[2]==='activity') return json(res,200,{ activity:db.prepare('SELECT a.*,u.name AS actor_name FROM activity a JOIN users u ON a.actor_id=u.id WHERE workspace_id=? ORDER BY created_at DESC LIMIT 30').all(wid) });
      return json(res,200,{ summary:db.prepare(`SELECT t.status,COUNT(*) AS count FROM tasks t JOIN boards b ON b.id=t.board_id WHERE b.workspace_id=? GROUP BY t.status`).all(wid), members: db.prepare('SELECT COUNT(*) AS n FROM members WHERE workspace_id=?').get(wid).n });
    }
    throw new ApiError(404,'Route not found');
  }
  const server = createHttpServer(apiServer(handler));
  return { server, db, close() { server.close(); db.close(); } };
}
if (process.argv[1]?.endsWith('/app.js')) {
  const { server } = createApp(); server.listen(Number(process.env.PORT || 4001), () => console.log('FlowBoard API on http://localhost:' + (process.env.PORT || 4001)));
}
