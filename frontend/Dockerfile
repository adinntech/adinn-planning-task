# syntax=docker/dockerfile:1

# ---- build: compile the Vite/React SPA ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Baked into the JS bundle at build time. The default "/api" is relative, so the
# browser calls the same origin that served the page and nginx (below) proxies
# it to the backend container. Override only to point at a separate API domain.
ARG VITE_API_URL=/api
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build

# ---- runtime: nginx serves static files and proxies API/file routes ----
FROM nginx:1.27-alpine AS runtime
# Substituted into /etc/nginx/templates/*.template at container start.
ENV BACKEND_UPSTREAM=http://backend:5001 \
    CLIENT_MAX_BODY_SIZE=300m
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
