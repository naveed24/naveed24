# CommerceIQ — E-Commerce & Operations Analytics

A **React + Node.js + SQLite** full-stack commerce demo featuring storefront shopping and administrative operations. This is a portfolio project: checkout **does not charge money** and does not integrate any payment gateway.

## Implemented features
- Public product catalog, search, category filtering and client-side basket.
- Registration/login, password hashing using scrypt, expiring signed bearer tokens.
- **Atomic checkout with inventory reservation:** SQLite `BEGIN IMMEDIATE` transaction, stock checks, order snapshots and rollback on errors.
- **Idempotency-Key checkout:** repeating a request with the same key returns the original order without double-reducing stock.
- Order history, admin order fulfillment/cancellation, automatic inventory restoration on cancellation.
- Customer/admin authorization, admin product creation/stock editing, revenue and best-seller analytics.
- Automated Node integration tests for checkout, idempotency, stock correctness and authorization.

## Run locally
Requires **Node.js 22.13+** (native `node:sqlite`, experimental warning on some Node 22 releases).

Backend:
```bash
cd server
# Example: set env variables in your terminal. Use a long random TOKEN_SECRET.
# macOS/Linux:
export ADMIN_EMAIL=admin@example.com
export ADMIN_PASSWORD='change-me-to-a-unique-password'
export TOKEN_SECRET='replace-with-a-long-random-unique-secret'
npm start
```
For Windows PowerShell, set the same variables using `$env:ADMIN_EMAIL="..."`, `$env:ADMIN_PASSWORD="..."`, `$env:TOKEN_SECRET="..."`, then run `npm start`.

The backend seeds 8 **demo** product records when the database is empty. Administrator login is bootstrapped only when both `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set on the **first run**. Change credentials before deploying.

Frontend:
```bash
cd client
npm install
npm run dev
```
Open http://localhost:5173; API runs on http://localhost:4002. Use different terminals. To develop both portfolio projects at once, assign distinct Vite ports and set matching `CLIENT_ORIGIN`.

Tests (backend needs no third-party packages):
```bash
cd server
npm test
```

## Architecture and correctness
The React UI uses REST endpoints served by a native Node HTTP backend. SQLite uses parameterized queries, foreign keys, stock check constraints and transactional order creation. Prices use **integer cents**, not floating-point currency values; each order item snapshots its unit price.

### Selected endpoints
| Method | Path | Permission |
|---|---|---|
| GET | `/api/products` | Public |
| POST | `/api/auth/register`, `/api/auth/login` | Public |
| POST | `/api/orders` | Authenticated; requires `Idempotency-Key` header |
| GET | `/api/orders` | Own orders; admin sees all |
| POST | `/api/admin/products` | Admin |
| PATCH | `/api/admin/products/:id` | Admin |
| PATCH | `/api/admin/orders/:id/status` | Admin |
| GET | `/api/admin/analytics` | Admin |

## Roadmap and boundaries
No payment capture, shipment provider, image upload, tax rules or multi-currency checkout. This starter is deliberately suited to a single Node process with SQLite; for internet-facing distributed deployment, add security rate limits, HTTPS, centralized sessions, production secrets, database migrations, and PostgreSQL. The React client stores tokens in localStorage for demonstration purposes only.
