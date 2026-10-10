# Production image (docs/10 §5): build CSS and vendor files, then a small runtime with prod deps only.

# --- build stage: dev dependencies are needed for Tailwind and the vendor copy ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- runtime stage ---
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY db ./db
COPY scripts/adminUser.js ./scripts/adminUser.js
COPY public ./public
COPY --from=build /app/public/css ./public/css
COPY --from=build /app/public/vendor ./public/vendor

# Never run as root.
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

# Migrations run as a separate one-off task before a new version starts: npm run db:migrate
CMD ["node", "src/server.js"]
