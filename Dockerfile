# Use official Puppeteer image with Chrome pre-installed
FROM ghcr.io/puppeteer/puppeteer:21.6.1

# Set environment variables
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    NODE_ENV=production \
    PORT=3000

# Create app directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including puppeteer-extra and stealth)
# Remove --production flag to install devDependencies if needed
RUN npm ci --only=production

# Copy application code
COPY . .

# Create directory for cookies with proper permissions
RUN mkdir -p /usr/src/app/data && \
    chown -R pptruser:pptruser /usr/src/app/data

# Expose port
EXPOSE 3000

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Run as non-root user (puppeteer image provides 'pptruser')
USER pptruser

# Start the application
CMD ["node", "server.js"]
