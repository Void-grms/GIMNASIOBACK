FROM node:22-bookworm-slim AS node
FROM php:8.4-cli-bookworm AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libxml2-dev unzip git && docker-php-ext-install dom && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer
WORKDIR /app
COPY billing-engine/composer.json billing-engine/composer.lock ./billing-engine/
RUN cd billing-engine && composer install --no-dev --prefer-dist --no-interaction --no-scripts --no-plugins --optimize-autoloader
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . .
# La generacion no necesita conectarse a una base ni recibir secretos del build.
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build npm run railway:build
ENV NODE_ENV=production
CMD ["node", "dist/src/main.js"]
