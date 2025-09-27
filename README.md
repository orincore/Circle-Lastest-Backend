# Circle Backend (Node.js + TypeScript)

Production-ready backend with Express, WebSockets (Socket.IO), REST + GraphQL, Supabase Auth, and AWS S3 uploads. Ready for Docker and AWS Lightsail.

## Quick Start

1. Copy env
```
cp .env.example .env
```
2. Install deps
```
npm install
```
3. Run dev
```
npm run dev
```
4. Build & start
```
npm run build && npm start
```

- REST health: `GET /health`
- REST auth: `POST /auth/signup`, `POST /auth/login`
- REST S3 presign: `POST /storage/presign-upload` { key, contentType } (requires Bearer token)
- GraphQL: `POST /graphql` with query `{ health, me { id email } }`
- WebSocket path: `/ws` (Socket.IO). Auth by `auth: { token: 'Bearer <jwt>' }` or `Authorization: Bearer <jwt>` header.

## Environment

- `PORT` default 8080
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` (and optionally `SUPABASE_SERVICE_ROLE_KEY`)
- `AWS_REGION`, `AWS_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- `CORS_ORIGIN` allowed origin

## Deploy on AWS Lightsail (Docker)

- Build locally: `docker build -t circle-backend .`
- Run: `docker run -p 8080:8080 --env-file .env circle-backend`
- In Lightsail, create a container service, push image to Lightsail Container Registry, set env vars, expose port 8080, and deploy.

## Notes

- Supabase auth is handled via JWT Bearer tokens. Use `/auth/login` to obtain `access_token` and include `Authorization: Bearer <token>` in requests.
- S3 uploads are via pre-signed URLs. Upload directly from client with `PUT` to the returned `url`.
