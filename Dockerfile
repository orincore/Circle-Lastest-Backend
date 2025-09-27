# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

FROM base AS deps
COPY package.json package-lock.json* pnpm-lock.yaml* yarn.lock* ./
RUN set -eux; \
  if [ -f package-lock.json ]; then npm ci --omit=dev; \
  elif [ -f yarn.lock ]; then yarn install --production; \
  elif [ -f pnpm-lock.yaml ]; then npm i -g pnpm && pnpm i --prod; \
  else npm i --omit=dev; fi

FROM base AS build
COPY package.json ./
RUN npm i
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM base AS runtime
USER node
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./package.json
EXPOSE 8080
CMD ["node", "dist/index.js"]
