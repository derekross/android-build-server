FROM node:20-bookworm

# Prevent interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y \
    openjdk-17-jdk \
    wget \
    unzip \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Set Java home
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV PATH=$PATH:$JAVA_HOME/bin

# Android SDK setup
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools

# Download and install Android command line tools
RUN mkdir -p $ANDROID_HOME/cmdline-tools && \
    cd $ANDROID_HOME/cmdline-tools && \
    wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O tools.zip && \
    unzip -q tools.zip && \
    rm tools.zip && \
    mv cmdline-tools latest

# Accept licenses and install SDK components
RUN yes | sdkmanager --licenses > /dev/null 2>&1 && \
    sdkmanager --install \
      "platform-tools" \
      "platforms;android-34" \
      "build-tools;34.0.0" \
      > /dev/null 2>&1

# Create non-root user for running the app with home directory
RUN groupadd -r apkbuild && useradd -r -g apkbuild -m -d /home/apkbuild apkbuild

# Create app directory
WORKDIR /app

# Install app dependencies
COPY package.json ./
RUN npm install --omit=dev

# Copy app source
COPY . .

# Create directories for builds and set permissions
RUN mkdir -p /tmp/builds /tmp/output /app/data && \
    chown -R apkbuild:apkbuild /tmp/builds /tmp/output /app/data /home/apkbuild && \
    chown -R apkbuild:apkbuild /app && \
    chmod -R 755 $ANDROID_HOME

# Switch to non-root user
USER apkbuild

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start server
CMD ["node", "server.js"]
