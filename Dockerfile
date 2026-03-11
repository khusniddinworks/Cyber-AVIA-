FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
  curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Set dynamic port for Render
ENV PORT=8080

# Forcing eventlet worker class. 
# We use --worker-class instead of -k for clarity.
# We set workers to 1 because SocketIO in-memory doesn't support multiple workers without a message queue like Redis.
CMD gunicorn --worker-class eventlet -w 1 -b 0.0.0.0:$PORT --timeout 120 --log-level debug app:app
