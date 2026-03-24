# ── deps stage: install all dependencies ───────────────────────────────────────
FROM node:20-alpine AS deps

RUN npm install -g pnpm@10.28.1

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile


# ── runner stage: lean production image ────────────────────────────────────────
FROM node:20-alpine AS runner

RUN npm install -g pnpm@10.28.1

# Install system tools:
#   curl          — healthchecks
#   poppler-utils — pdftotext (text PDF extraction)
#   tesseract-ocr — OCR engine for scanned PDFs
#   py3-pip       — needed to install ocrmypdf
RUN apk add --no-cache curl poppler-utils tesseract-ocr tesseract-ocr-data-eng py3-pip && \
    pip3 install --break-system-packages ocrmypdf

# Run as non-root
RUN addgroup -S permito && adduser -S permito -G permito

WORKDIR /app

# Copy installed deps and source
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=permito:permito . .

USER permito

# MCP server (httpStream) and REST API
EXPOSE 3000 4000

CMD ["pnpm", "start:http"]
