# Node 20 + Chromium for Playwright PDF generation
FROM node:20-bookworm-slim

WORKDIR /app

# Install Chromium system dependencies (required for Playwright)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
    libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Install deps and build
COPY package*.json tsconfig.json ./
# Keep this list in sync with local pdf-server sources
COPY index.ts htmlGenerator.ts paths.ts loadEnv.ts seedGeneratedPdfs.ts pdfWorker.ts instancePdfGenerator.ts sharepointUpload.ts pdfFileNaming.ts splitCoverHtml.ts appendixAMatrixData.ts inductionHtml.ts instructionBlocksHtml.ts pdfBrowser.ts pdfMemory.ts pdfConstants.ts pdfRender.ts logoUrls.ts assessmentQuestionBlock.ts writtenEvidenceChecklist.ts ./
COPY public/ ./public/
RUN npm ci && npm run build

EXPOSE 3001
ENV PORT=3001
# Leave headroom for Chromium inside 512MB containers; use Standard 2GB+ plan for large forms.
ENV NODE_OPTIONS=--max-old-space-size=256

CMD ["node", "dist/index.js"]
