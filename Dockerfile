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

# Using GEVENT worker. This is superior to eventlet for stability.
# We set workers to 1 to ensure SocketIO session consistency without Redis.
CMD gunicorn -k geventwebsocket.gunicorn.workers.GeventWebSocketWorker -w 1 -b 0.0.0.0:$PORT --timeout 120 --log-level info app:app
