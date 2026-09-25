FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_SOLEIL_PROGRAM_ID
ARG VITE_SOLANA_RPC_URL=https://api.devnet.solana.com
ARG VITE_SOLEIL_QUOTES_URL=/api/quotes
ENV VITE_SOLEIL_PROGRAM_ID=$VITE_SOLEIL_PROGRAM_ID VITE_SOLANA_RPC_URL=$VITE_SOLANA_RPC_URL VITE_SOLEIL_QUOTES_URL=$VITE_SOLEIL_QUOTES_URL
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 AGENT_PORT=8788
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
EXPOSE 8788
CMD ["node", "server/agent.mjs"]
