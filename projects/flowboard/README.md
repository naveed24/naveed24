# FlowBoard — Team Project Management

**React + Node.js + SQLite** full-stack Kanban application for collaborative teams. Built as a portfolio demonstration; not a hosted production service.

## Features implemented
- Account registration/login with scrypt password hashes and signed, expiring bearer tokens.
- Workspaces with `OWNER` / `MEMBER` access control and registered-user invitations.
- Multiple boards, tasks, assignees, priorities, search/filter and drag-and-drop task status updates.
- Optimistic concurrency control on tasks using `version`; stale updates return HTTP 409.
- Workspace activity history, team roster, and metrics.
- Relational SQLite schema with foreign keys and indexes; backend tests using Node's built-in test runner.

## Run locally
Requires **Node.js 22.13+** (uses built-in `node:sqlite`, which emits an experimental warning on some Node 22 versions).

Terminal 1:
```bash
cd server
# Set TOKEN_SECRET to a long random string for deployments (development fallback is NOT secure).
npm start
```
API: http://localhost:4001

Terminal 2:
```bash
cd client
npm install
npm run dev
```
Open http://localhost:5173. Register an account, create a workspace, then create/drag tasks. To invite a colleague, they must register first.

Tests (no third-party server packages required):
```bash
cd server
npm test
```

## Architecture
`client/` is the React single-page UI (Vite); `server/` is a dependency-free Node HTTP REST API backed by SQLite. IDs use cryptographic randomness. DB writes use SQL constraints and version-checked updates. Backend uses parameterized queries. The dashboard's metrics currently report totals, not sprint velocity.

### Key endpoints
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login` | Account access |
| GET/POST | `/api/workspaces` | Workspaces |
| GET/POST | `/api/workspaces/:id/members` | Membership (POST owner only) |
| GET/POST | `/api/workspaces/:id/boards` | Boards |
| GET/POST | `/api/boards/:id/tasks` | Tasks |
| PATCH | `/api/tasks/:id` | Version-checked task update |
| GET | `/api/workspaces/:id/metrics` | Task and team summary |
| GET | `/api/workspaces/:id/activity` | Activity timeline |

## Limitations / next improvements
No real-time WebSocket sync, email delivery, password reset or production-grade session revocation. Add request throttling, audit retention, HTTPS, database migrations and integration with a managed DB before internet deployment. The client stores bearer tokens in localStorage for portfolio simplicity.

## Security
**Never commit `.env` files or real credentials.** Use `server/.env.example` as configuration guidance; the program reads environment variables supplied by your shell or platform. Change `TOKEN_SECRET` outside local development.
