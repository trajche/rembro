FROM node:20-bookworm

# System packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    supervisor \
    openssh-server \
    fonts-liberation \
    fonts-noto-color-emoji \
    dbus-x11 \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright's bundled Chromium with dependencies
RUN npx playwright install chromium --with-deps

# SSH setup
RUN mkdir -p /run/sshd && \
    adduser --disabled-password --gecos "" tunnel && \
    sed -i 's/^tunnel:!/tunnel:/' /etc/shadow && \
    mkdir -p /home/tunnel/.ssh && \
    chown tunnel:tunnel /home/tunnel/.ssh && \
    chmod 700 /home/tunnel/.ssh && \
    usermod -s /bin/sh tunnel && \
    # Generate SSH host keys
    ssh-keygen -A

# Copy SSH config and key generation script
COPY docker/browser/sshd_config /etc/ssh/sshd_config
COPY docker/browser/generate-keys.sh /usr/local/bin/generate-keys.sh
RUN chmod +x /usr/local/bin/generate-keys.sh

# Copy CLI
COPY cli/ /app/cli/

# Build MCP server
COPY mcp-server/ /app/mcp-server/
WORKDIR /app/mcp-server
RUN npm install && npm run build

# Supervisor config
COPY docker/browser/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

ENV DISPLAY=:99
ENV NODE_ENV=production

EXPOSE 3000 6080 2222

CMD ["/bin/bash", "-c", "/usr/local/bin/generate-keys.sh && exec /usr/bin/supervisord -n -c /etc/supervisor/conf.d/supervisord.conf"]
